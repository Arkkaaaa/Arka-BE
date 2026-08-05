import { randomUUID } from 'node:crypto';
import { GameMetricsSchema, type GameMetrics } from '../schemas/index.js';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { PrismaClient } from '../generated/prisma/client.js';

const INDONESIAN_CUE =
  /\b(?:adalah|agar|akurasi|atau|baik|belum|buah|cepat|cukup|dalam|dan|dapat|dengan|di|dari|durasi|genggaman|hasil|ini|juga|karena|ke|kilogram|kinerja|konsisten|lambat|level|lebih|memori|mencapai|menunjukkan|performa|permainan|perlu|pada|rata-rata|reaksi|respons|ringkasan|sesi|skor|stabil|stimulus|sudah|target|tercatat|tidak|tingkat|untuk|yang)\b/iu;
const PLAIN_TEXT = /^[\p{L}\p{N} ,.;:!?()%'’-]+$/u;
const PROHIBITED_SUMMARY_TEXT =
  /(?:<[^>]*>|\[[^\]]*\]\([^)]*\)|(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)|\b(?:identitas|nama|diagnos\w*|demensia|alzheimer|medis|klinis|terapi|pengobatan|rekomendasi|saran|anjuran|risiko|normal|abnormal|bahaya|sebaiknya|silakan|harus|lakukan|coba|tingkatkan|kurangi|konsultasikan)\b)/iu;
const METRIC_CUES = {
  MOTOR_GRIP:
    /\b(?:skor|buah|stroberi|tomat|pisang|jeruk|apel|semangka|kilogram|kg|kekuatan puncak|genggaman puncak|genggaman rata-rata|rata-rata genggaman|tahanan kontinu|waktu di atas target|target|waktu permainan)\b/iu,
  GO_NO_GO:
    /\b(?:skor|level|tingkat|durasi stimulus|total stimulus|stimulus target|stimulus non-target|respons tepat|belum merespons|false positive|berhasil menunggu|akurasi|waktu respons)\b/iu,
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
  const { mode, ...metrics } = source.metrics;
  const aggregateMetrics = mode === 'MOTOR_GRIP'
    ? Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'gripSamples'))
    : metrics;
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
  for (const audience of [output.participant, output.clinician]) {
    for (const text of [audience.summaryText, ...audience.observations]) {
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

const AudienceSummarySchema = z
  .object({
    summaryText: plainIndonesianText(280),
    observations: z.array(plainIndonesianText(140)).max(3),
  })
  .strict();

const SummaryOutputSchema = z
  .object({
    participant: AudienceSummarySchema,
    clinician: AudienceSummarySchema,
  })
  .strict();

const OllamaResponseSchema = z.object({ message: z.object({ content: z.string() }) }).passthrough();
const OpenAiResponseSchema = z
  .object({
    choices: z
      .array(z.object({ message: z.object({ content: z.string() }) }).passthrough())
      .min(1),
  })
  .passthrough();

const AUDIENCE_SUMMARY_FORMAT = {
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

const SUMMARY_FORMAT = {
  type: 'object',
  additionalProperties: false,
  required: ['participant', 'clinician'],
  properties: {
    participant: AUDIENCE_SUMMARY_FORMAT,
    clinician: AUDIENCE_SUMMARY_FORMAT,
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
class AiProviderHttpError extends Error {}

export interface AiSummaryWorkerDependencies {
  readonly prisma: PrismaClient;
  readonly env: Env;
  readonly logger: Logger;
}

/** Polls saved session summaries through the configured AI provider. */
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
    } catch (error) {
      if (!this.#stopping)
        this.dependencies.logger.error({ err: error }, 'Worker ringkasan AI lokal gagal diproses');
    }
  }

  private async expireExhaustedLeases(): Promise<void> {
    const { prisma, env } = this.dependencies;
    const now = new Date();
    await prisma.trAiSessionSummary.updateMany({
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
      const candidate = await prisma.trAiSessionSummary.findFirst({
        where: eligible,
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;

      const leaseToken = randomUUID();
      const claimed = await prisma.trAiSessionSummary.updateMany({
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

      const loaded = await prisma.trAiSessionSummary.findFirst({
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

      await this.dependencies.prisma.trAiSessionSummary.updateMany({
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
          summaryText: output.participant.summaryText,
          observations: output,
          unavailableReason: null,
        },
      });
    } catch (error) {
      if (this.#stopping || error instanceof LeaseLostError) return;
      if (!(error instanceof AiProviderHttpError))
        this.dependencies.logger.warn(
          {
            summaryId: summary.id,
            attemptCount: summary.attemptCount,
            provider: this.dependencies.env.OLLAMA_PROVIDER,
            model: this.dependencies.env.OLLAMA_MODEL,
            timeoutMs: this.dependencies.env.OLLAMA_TIMEOUT_MS,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            timedOut: error instanceof Error && error.name === 'AbortError',
          },
          'Pembuatan ringkasan AI gagal',
        );
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
    await this.dependencies.prisma.trAiSessionSummary.updateMany({
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
      void prisma.trAiSessionSummary
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
      const messages = [
        {
          role: 'system',
          content:
            'Tulis dua ringkasan hasil permainan dalam bahasa Indonesia berdasarkan hanya metrik agregat yang diberikan. Balas JSON ketat sesuai skema dengan participant dan clinician, masing-masing berisi summaryText satu kalimat dan observations paling banyak tiga pengamatan singkat. Semua teks wajib faktual, menyebut angka dan nama metrik yang tersedia, tanpa markdown. Jangan menyebut atau menebak identitas, diagnosis, kondisi medis atau klinis, risiko, terapi, pengobatan, saran, anjuran, atau rekomendasi. Untuk participant gunakan bahasa sederhana, mudah dipahami, dan bernada menyemangati secara netral tanpa instruksi. Untuk clinician gunakan bahasa ringkas dan lebih berfokus pada angka metrik, tetapi tetap nonklinis.',
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
      ];
      const openAiCompatible = env.OLLAMA_PROVIDER === 'openai';
      const response = await fetch(
        openAiCompatible
          ? `${env.OLLAMA_BASE_URL}/chat/completions`
          : `${env.OLLAMA_BASE_URL}/api/chat`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(openAiCompatible ? { authorization: `Bearer ${env.OLLAMA_API_KEY}` } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify(
            openAiCompatible
              ? {
                  model: env.OLLAMA_MODEL,
                  messages,
                  temperature: 0.2,
                  response_format: { type: 'json_object' },
                }
              : {
                  model: env.OLLAMA_MODEL,
                  stream: false,
                  format: SUMMARY_FORMAT,
                  options: { temperature: 0.2 },
                  messages,
                },
          ),
        },
      );
      if (!response.ok) {
        this.dependencies.logger.warn(
          {
            status: response.status,
            provider: env.OLLAMA_PROVIDER,
            model: env.OLLAMA_MODEL,
          },
          'AI provider HTTP request gagal',
        );
        throw new AiProviderHttpError('AI summary request failed');
      }

      const responseBody: unknown = await response.json();
      const content = openAiCompatible
        ? OpenAiResponseSchema.parse(responseBody).choices[0]!.message.content
        : OllamaResponseSchema.parse(responseBody).message.content;
      const output = parseGroundedSummaryOutput(summary.session.mode, JSON.parse(content));
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
