import { randomUUID } from 'node:crypto';
import { GameMetricsSchema, type GameMetrics } from '../schemas/index.js';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { PrismaClient } from '../generated/prisma/client.js';

const INDONESIAN_CUE =
  /\b(?:adalah|agar|atau|baik|belum|cepat|cukup|dalam|dan|dapat|dengan|di|dari|genggaman|hasil|ini|juga|karena|ke|kinerja|konsisten|lambat|lebih|memori|menunjukkan|performa|permainan|perlu|pada|reaksi|respons|ringkasan|sesi|skor|stabil|sudah|target|tercatat|tidak|tingkat|untuk|yang)\b/iu;
const PLAIN_TEXT = /^[\p{L}\p{N} ,.;:!?()%'’-]+$/u;
const PROHIBITED_SUMMARY_TEXT =
  /(?:<[^>]*>|\[[^\]]*\]\([^)]*\)|(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)|\b(?:diagnos\w*|demensia|alzheimer|terapi|pengobatan|risiko|normal|abnormal|bahaya|sebaiknya|silakan|harus|lakukan|coba|tingkatkan|kurangi|konsultasikan)\b)/iu;
const METRIC_CUES = {
  MOTOR_GRIP: /\b(?:skor|kekuatan puncak|tahanan kontinu|target|waktu permainan)\b/iu,
  GO_NO_GO:
    /\b(?:skor|total stimulus|stimulus target|stimulus non-target|respons tepat|belum merespons|false positive|berhasil menunggu|akurasi|waktu respons)\b/iu,
  SEQUENCE_MEMORY:
    /\b(?:skor|urutan terpanjang|level selesai|attempt salah|timeout|tombol ganda|waktu respons|jeda antar tombol|alasan selesai)\b/iu,
} as const;

interface AiSummaryInputSource {
  readonly mode: GameMetrics['mode'];
  readonly ruleVersion: string;
  readonly completedAt: Date;
  readonly score: number;
  readonly metrics: GameMetrics;
}

export function buildAiSummaryInput(source: AiSummaryInputSource) {
  const { mode, ...aggregateMetrics } = source.metrics;
  if (mode !== source.mode) throw new TypeError('Metric mode mismatch');
  const sessionHour = new Date(source.completedAt);
  sessionHour.setUTCMinutes(0, 0, 0);
  return {
    mode: source.mode,
    ruleVersion: source.ruleVersion,
    sessionHourUtc: sessionHour.toISOString(),
    metrics: { score: source.score, ...aggregateMetrics },
  };
}

export function parseGroundedSummaryOutput(mode: GameMetrics['mode'], value: unknown) {
  const output = SummaryOutputSchema.parse(value);
  for (const text of [output.summaryText, ...output.observations]) {
    if (PROHIBITED_SUMMARY_TEXT.test(text) || !METRIC_CUES[mode].test(text) || !/\d/u.test(text)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: [],
          message: 'Summary text must be nonclinical and grounded in an allowlisted metric',
        },
      ]);
    }
  }
  return output;
}

export function retryBackoffMs(attemptCount: number, baseMs: number): number {
  return Math.min(60_000, baseMs * 2 ** Math.max(0, attemptCount - 1));
}

function plainIndonesianText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => PLAIN_TEXT.test(value) && !/ {2,}/u.test(value) && INDONESIAN_CUE.test(value),
      'Expected plain Indonesian text',
    );
}

const SummaryOutputSchema = z
  .object({
    summaryText: plainIndonesianText(280),
    observations: z.array(plainIndonesianText(140)).max(3),
  })
  .strict();

const OllamaResponseSchema = z.object({ message: z.object({ content: z.string() }) }).passthrough();

const SUMMARY_FORMAT = {
  type: 'object',
  additionalProperties: false,
  required: ['summaryText', 'observations'],
  properties: {
    summaryText: { type: 'string', maxLength: 280 },
    observations: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 140 },
    },
  },
} as const;

type FailureReason = 'METRICS_INVALID' | 'OLLAMA_REQUEST_FAILED' | 'OLLAMA_RESPONSE_INVALID';

interface ClaimedSummary {
  readonly id: string;
  readonly leaseToken: string;
  readonly attemptCount: number;
  readonly session: {
    readonly mode: GameMetrics['mode'];
    readonly completedAt: Date;
    readonly ruleVersion: { readonly version: string };
    readonly result: {
      readonly score: number;
      readonly metrics: unknown;
    };
  };
}

class LeaseLostError extends Error {}

export interface AiSummaryWorkerDependencies {
  readonly prisma: PrismaClient;
  readonly env: Env;
  readonly logger: Logger;
}

/** Polls saved session summaries and keeps all model data local to the configured Ollama server. */
export class AiSummaryWorker {
  #timer: NodeJS.Timeout | null = null;
  #activeTick: Promise<void> | null = null;
  #activeRequest: AbortController | null = null;
  #stopping = false;

  constructor(private readonly dependencies: AiSummaryWorkerDependencies) {}

  start(): void {
    if (this.#timer || this.#activeTick) return;

    this.#stopping = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.dependencies.env.OLLAMA_WORKER_INTERVAL_MS);
    this.#timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#activeRequest?.abort();
    await this.#activeTick;
  }

  private async tick(): Promise<void> {
    if (this.#activeTick) return this.#activeTick;

    const active = this.run();
    this.#activeTick = active;
    try {
      await active;
    } finally {
      if (this.#activeTick === active) this.#activeTick = null;
    }
  }

  private async run(): Promise<void> {
    try {
      if (this.#stopping) return;
      await this.expireExhaustedLeases();
      const summary = await this.claimNext();
      if (summary && !this.#stopping) await this.process(summary);
    } catch {
      if (!this.#stopping)
        this.dependencies.logger.error('Worker ringkasan AI lokal gagal diproses');
    }
  }

  private async expireExhaustedLeases(): Promise<void> {
    const { prisma, env } = this.dependencies;
    const now = new Date();
    await prisma.aiSessionSummary.updateMany({
      where: {
        attemptCount: { gte: env.OLLAMA_MAX_ATTEMPTS },
        OR: [
          { status: 'PENDING' },
          {
            status: 'PROCESSING',
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
        ],
        session: { is: { status: 'SAVED', result: { isNot: null } } },
      },
      data: {
        status: 'UNAVAILABLE',
        leaseToken: null,
        leaseExpiresAt: null,
        unavailableReason: 'OLLAMA_REQUEST_FAILED',
      },
    });
  }

  private async claimNext(): Promise<ClaimedSummary | null> {
    const { prisma, env } = this.dependencies;
    const now = new Date();
    const eligible = {
      attemptCount: { lt: env.OLLAMA_MAX_ATTEMPTS },
      availableAt: { lte: now },
      OR: [
        { status: 'PENDING' as const },
        {
          status: 'PROCESSING' as const,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
      ],
      session: { is: { status: 'SAVED' as const, result: { isNot: null } } },
    };

    for (let attempt = 0; attempt < 3 && !this.#stopping; attempt += 1) {
      const candidate = await prisma.aiSessionSummary.findFirst({
        where: eligible,
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;

      const leaseToken = randomUUID();
      const claimed = await prisma.aiSessionSummary.updateMany({
        where: { id: candidate.id, ...eligible },
        data: {
          status: 'PROCESSING',
          attemptCount: { increment: 1 },
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + env.OLLAMA_LEASE_MS),
          unavailableReason: null,
        },
      });
      if (claimed.count !== 1) continue;

      const loaded = await prisma.aiSessionSummary.findFirst({
        where: {
          id: candidate.id,
          status: 'PROCESSING',
          leaseToken,
          session: { is: { status: 'SAVED', result: { isNot: null } } },
        },
        select: {
          id: true,
          leaseToken: true,
          attemptCount: true,
          session: {
            select: {
              mode: true,
              completedAt: true,
              ruleVersion: { select: { version: true } },
              result: { select: { score: true, metrics: true } },
            },
          },
        },
      });
      if (!loaded?.leaseToken || !loaded.session.result) return null;

      return {
        id: loaded.id,
        leaseToken: loaded.leaseToken,
        attemptCount: loaded.attemptCount,
        session: {
          mode: loaded.session.mode,
          completedAt: loaded.session.completedAt ?? new Date(0),
          ruleVersion: loaded.session.ruleVersion,
          result: loaded.session.result,
        },
      };
    }

    return null;
  }

  private async process(summary: ClaimedSummary): Promise<void> {
    const metrics = GameMetricsSchema.safeParse(summary.session.result.metrics);
    if (!metrics.success || metrics.data.mode !== summary.session.mode) {
      await this.completeFailure(summary, 'METRICS_INVALID');
      return;
    }

    try {
      const output = await this.generateSummary(summary, metrics.data);
      if (this.#stopping) return;

      await this.dependencies.prisma.aiSessionSummary.updateMany({
        where: {
          id: summary.id,
          status: 'PROCESSING',
          leaseToken: summary.leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
          summaryText: output.summaryText,
          observations: output.observations,
          unavailableReason: null,
        },
      });
    } catch (error) {
      if (this.#stopping || error instanceof LeaseLostError) return;
      await this.completeFailure(
        summary,
        error instanceof SyntaxError || error instanceof z.ZodError
          ? 'OLLAMA_RESPONSE_INVALID'
          : 'OLLAMA_REQUEST_FAILED',
      );
    }
  }

  private async completeFailure(summary: ClaimedSummary, reason: FailureReason): Promise<void> {
    if (this.#stopping) return;

    const unavailable = summary.attemptCount >= this.dependencies.env.OLLAMA_MAX_ATTEMPTS;
    await this.dependencies.prisma.aiSessionSummary.updateMany({
      where: {
        id: summary.id,
        status: 'PROCESSING',
        leaseToken: summary.leaseToken,
        leaseExpiresAt: { gt: new Date() },
      },
      data: unavailable
        ? {
            status: 'UNAVAILABLE',
            leaseToken: null,
            leaseExpiresAt: null,
            unavailableReason: reason,
          }
        : {
            status: 'PENDING',
            leaseToken: null,
            leaseExpiresAt: null,
            unavailableReason: null,
            availableAt: new Date(
              Date.now() +
                retryBackoffMs(
                  summary.attemptCount,
                  this.dependencies.env.OLLAMA_WORKER_INTERVAL_MS,
                ),
            ),
          },
    });
  }

  private async generateSummary(
    summary: ClaimedSummary,
    metrics: z.infer<typeof GameMetricsSchema>,
  ) {
    const controller = new AbortController();
    const { env, prisma } = this.dependencies;
    let leaseLost = false;
    const renewEveryMs = Math.max(1, Math.floor(env.OLLAMA_LEASE_MS / 3));
    const timeout = setTimeout(() => controller.abort(), env.OLLAMA_TIMEOUT_MS);
    const renewal = setInterval(() => {
      if (this.#stopping) {
        controller.abort();
        return;
      }
      void prisma.aiSessionSummary
        .updateMany({
          where: {
            id: summary.id,
            status: 'PROCESSING',
            leaseToken: summary.leaseToken,
            leaseExpiresAt: { gt: new Date() },
          },
          data: { leaseExpiresAt: new Date(Date.now() + env.OLLAMA_LEASE_MS) },
        })
        .then(({ count }) => {
          if (count !== 1) {
            leaseLost = true;
            controller.abort();
          }
        })
        .catch(() => {
          leaseLost = true;
          controller.abort();
        });
    }, renewEveryMs);
    timeout.unref();
    renewal.unref();
    this.#activeRequest = controller;

    try {
      const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: env.OLLAMA_MODEL,
          stream: false,
          format: SUMMARY_FORMAT,
          options: { temperature: 0.2 },
          messages: [
            {
              role: 'system',
              content:
                'Tulis ringkasan hasil permainan dalam bahasa Indonesia yang singkat, netral, dan mudah dipahami. Gunakan hanya data agregat yang diberikan. Jangan menyebut identitas, membuat diagnosis medis, atau memberi saran klinis. Balas JSON sesuai skema: summaryText satu kalimat; observations berisi paling banyak tiga pengamatan singkat tanpa markdown.',
            },
            {
              role: 'user',
              content: `Data agregat sesi: ${JSON.stringify(
                buildAiSummaryInput({
                  mode: summary.session.mode,
                  ruleVersion: summary.session.ruleVersion.version,
                  completedAt: summary.session.completedAt,
                  score: summary.session.result.score,
                  metrics,
                }),
              )}`,
            },
          ],
        }),
      });
      if (!response.ok) throw new Error('Ollama request failed');

      const envelope = OllamaResponseSchema.parse(await response.json());
      const output = parseGroundedSummaryOutput(
        summary.session.mode,
        JSON.parse(envelope.message.content),
      );
      if (leaseLost) throw new LeaseLostError();
      return output;
    } catch (error) {
      if (leaseLost) throw new LeaseLostError();
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
      if (this.#activeRequest === controller) this.#activeRequest = null;
    }
  }
}

export function createAiSummaryWorker(dependencies: AiSummaryWorkerDependencies): AiSummaryWorker {
  return new AiSummaryWorker(dependencies);
}
