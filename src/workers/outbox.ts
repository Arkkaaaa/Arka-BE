import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { PrismaClient } from '../generated/prisma/client.js';

const OUTBOX_EVENT_TYPE = 'SESSION_FINALIZATION_FAILED';
const FinalizationAlertPayloadSchema = z
  .object({
    institutionId: z.string().uuid(),
    sessionId: z.string().uuid(),
    failureCode: z.string().min(1).max(80),
    failedAt: z.iso.datetime(),
  })
  .strict();

interface ClaimedEvent {
  readonly id: string;
  readonly eventKey: string;
  readonly type: typeof OUTBOX_EVENT_TYPE;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly leaseToken: string;
  readonly attemptCount: number;
}

type DeliveryFailureCode = 'PAYLOAD_INVALID' | 'WEBHOOK_REQUEST_FAILED' | `WEBHOOK_HTTP_${number}`;

class LeaseLostError extends Error {}

export interface OutboxWorkerDependencies {
  readonly prisma: PrismaClient;
  readonly env: Env;
  readonly logger: Logger;
}

export function outboxRetryBackoffMs(attemptCount: number, baseMs: number): number {
  return Math.min(60_000, baseMs * 2 ** Math.max(0, attemptCount - 1));
}

/** Delivers durable operational events to the configured idempotent webhook receiver. */
export class OutboxWorker {
  #timer: NodeJS.Timeout | null = null;
  #activeTick: Promise<void> | null = null;
  #activeRequest: AbortController | null = null;
  #stopping = false;

  constructor(private readonly dependencies: OutboxWorkerDependencies) {}

  start(): void {
    if (this.#timer || this.#activeTick) return;

    this.#stopping = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.dependencies.env.OUTBOX_WORKER_INTERVAL_MS);
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
      const event = await this.claimNext();
      if (event && this.#stopping) await this.releaseClaim(event.id, event.leaseToken);
      else if (event) await this.deliver(event);
    } catch (error) {
      if (!this.#stopping)
        this.dependencies.logger.error({ err: error }, 'Worker outbox alert gagal diproses');
    }
  }

  private async expireExhaustedLeases(): Promise<void> {
    const { prisma, env } = this.dependencies;
    const now = new Date();
    const expired = await prisma.outboxEvent.updateMany({
      where: {
        type: OUTBOX_EVENT_TYPE,
        attemptCount: { gte: env.OUTBOX_MAX_ATTEMPTS },
        OR: [
          { status: 'PENDING' },
          {
            status: 'PROCESSING',
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
        ],
      },
      data: {
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'MAX_ATTEMPTS_EXHAUSTED',
      },
    });
    if (expired.count > 0) {
      this.dependencies.logger.error(
        { count: expired.count },
        'Event outbox alert gagal permanen setelah retry habis',
      );
    }
  }

  private async claimNext(): Promise<ClaimedEvent | null> {
    const { prisma, env } = this.dependencies;
    const now = new Date();
    const eligible = {
      type: OUTBOX_EVENT_TYPE,
      attemptCount: { lt: env.OUTBOX_MAX_ATTEMPTS },
      availableAt: { lte: now },
      OR: [
        { status: 'PENDING' as const },
        {
          status: 'PROCESSING' as const,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
      ],
    };

    for (let attempt = 0; attempt < 3 && !this.#stopping; attempt += 1) {
      const candidate = await prisma.outboxEvent.findFirst({
        where: eligible,
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;

      const leaseToken = randomUUID();
      const claimed = await prisma.outboxEvent.updateMany({
        where: { id: candidate.id, ...eligible },
        data: {
          status: 'PROCESSING',
          attemptCount: { increment: 1 },
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + env.OUTBOX_LEASE_MS),
          lastErrorCode: null,
        },
      });
      if (claimed.count !== 1) continue;
      if (this.#stopping) {
        await this.releaseClaim(candidate.id, leaseToken);
        return null;
      }

      const loaded = await prisma.outboxEvent.findFirst({
        where: {
          id: candidate.id,
          type: OUTBOX_EVENT_TYPE,
          status: 'PROCESSING',
          leaseToken,
        },
        select: {
          id: true,
          eventKey: true,
          type: true,
          payload: true,
          createdAt: true,
          leaseToken: true,
          attemptCount: true,
        },
      });
      if (!loaded?.leaseToken || loaded.type !== OUTBOX_EVENT_TYPE) return null;

      return {
        id: loaded.id,
        eventKey: loaded.eventKey,
        type: loaded.type,
        payload: loaded.payload,
        createdAt: loaded.createdAt,
        leaseToken: loaded.leaseToken,
        attemptCount: loaded.attemptCount,
      };
    }

    return null;
  }

  private async deliver(event: ClaimedEvent): Promise<void> {
    const parsedPayload = FinalizationAlertPayloadSchema.safeParse(event.payload);
    if (!parsedPayload.success) {
      await this.completeFailure(event, 'PAYLOAD_INVALID');
      return;
    }

    try {
      await this.postAlert(event, parsedPayload.data);
      // The lease token, not wall-clock expiry, fences this completion against reclaims.

      const completed = await this.dependencies.prisma.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: 'PROCESSING',
          leaseToken: event.leaseToken,
        },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        },
      });
      if (completed.count !== 1) throw new LeaseLostError();
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      const failureCode: DeliveryFailureCode =
        error instanceof WebhookHttpError
          ? `WEBHOOK_HTTP_${error.status}`
          : 'WEBHOOK_REQUEST_FAILED';
      await this.completeFailure(event, failureCode);
    }
  }

  private async completeFailure(
    event: ClaimedEvent,
    failureCode: DeliveryFailureCode,
  ): Promise<void> {
    const failed = event.attemptCount >= this.dependencies.env.OUTBOX_MAX_ATTEMPTS;
    const completed = await this.dependencies.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: 'PROCESSING',
        leaseToken: event.leaseToken,
      },
      data: failed
        ? {
            status: 'FAILED',
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: failureCode,
          }
        : {
            status: 'PENDING',
            availableAt: new Date(
              Date.now() +
                outboxRetryBackoffMs(
                  event.attemptCount,
                  this.dependencies.env.OUTBOX_WORKER_INTERVAL_MS,
                ),
            ),
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: failureCode,
          },
    });
    if (failed && completed.count === 1) {
      this.dependencies.logger.error(
        { eventId: event.id, eventKey: event.eventKey, failureCode },
        'Event outbox alert gagal permanen',
      );
    }
  }

  private async releaseClaim(id: string, leaseToken: string): Promise<void> {
    await this.dependencies.prisma.outboxEvent.updateMany({
      where: { id, status: 'PROCESSING', leaseToken },
      data: {
        status: 'PENDING',
        attemptCount: { decrement: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }

  private async postAlert(
    event: ClaimedEvent,
    payload: z.infer<typeof FinalizationAlertPayloadSchema>,
  ): Promise<void> {
    const { env } = this.dependencies;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.OUTBOX_REQUEST_TIMEOUT_MS);
    timeout.unref();
    this.#activeRequest = controller;

    try {
      const response = await fetch(env.OPERATIONS_ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.OPERATIONS_ALERT_WEBHOOK_TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': event.eventKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          id: event.id,
          eventKey: event.eventKey,
          type: event.type,
          occurredAt: event.createdAt.toISOString(),
          payload,
        }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new WebhookHttpError(response.status);
    } finally {
      clearTimeout(timeout);
      if (this.#activeRequest === controller) this.#activeRequest = null;
    }
  }
}

class WebhookHttpError extends Error {
  constructor(readonly status: number) {
    super('Operational alert webhook rejected the event');
  }
}

export function createOutboxWorker(dependencies: OutboxWorkerDependencies): OutboxWorker {
  return new OutboxWorker(dependencies);
}
