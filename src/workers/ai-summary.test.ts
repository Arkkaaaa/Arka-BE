import type { Env } from '../config/env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiSummaryWorker,
  buildAiSummaryInput,
  parseGroundedSummaryOutput,
  retryBackoffMs,
} from './ai-summary.js';

describe('AI summary data boundary', () => {
  it('builds a de-identified allowlist DTO with an hourly timestamp', () => {
    const input = buildAiSummaryInput({
      mode: 'MOTOR_GRIP',
      ruleVersion: 'mvp-1.0.0',
      completedAt: new Date('2026-07-26T13:47:52.123Z'),
      score: 850,
      metrics: {
        mode: 'MOTOR_GRIP',
        peakGripPercent: 82,
        continuousHoldMs: 5_000,
        targetCompleted: true,
        sessionElapsedMs: 12_400,
      },
    });

    expect(input).toEqual({
      mode: 'MOTOR_GRIP',
      ruleVersion: 'mvp-1.0.0',
      sessionHourUtc: '2026-07-26T13:00:00.000Z',
      metrics: {
        score: 850,
        peakGripPercent: 82,
        continuousHoldMs: 5_000,
        targetCompleted: true,
        sessionElapsedMs: 12_400,
      },
    });
    expect(JSON.stringify(input)).not.toMatch(/participant|institution|sessionId|device|seed/iu);
  });

  it('accepts plain Indonesian observations grounded in the supplied mode metrics', () => {
    expect(
      parseGroundedSummaryOutput('MOTOR_GRIP', {
        summaryText: 'Skor sesi tercatat 850 dengan kekuatan puncak 82 persen.',
        observations: ['Tahanan kontinu tercatat 5000 milidetik.'],
      }),
    ).toEqual({
      summaryText: 'Skor sesi tercatat 850 dengan kekuatan puncak 82 persen.',
      observations: ['Tahanan kontinu tercatat 5000 milidetik.'],
    });
  });

  it.each([
    'Sebaiknya lakukan terapi karena skor sesi tercatat 850.',
    'Risiko demensia rendah berdasarkan skor sesi 850.',
    'Skor sesi 850 tersedia di www.example.test.',
    '**Skor sesi 850**',
    'Permainan telah selesai dengan baik.',
  ])('rejects prohibited or ungrounded model text: %s', (summaryText) => {
    expect(() =>
      parseGroundedSummaryOutput('MOTOR_GRIP', { summaryText, observations: [] }),
    ).toThrow();
  });
});

describe('AI summary retry backoff', () => {
  it('backs off exponentially and caps the delay', () => {
    expect(retryBackoffMs(1, 5_000)).toBe(5_000);
    expect(retryBackoffMs(2, 5_000)).toBe(10_000);
    expect(retryBackoffMs(3, 5_000)).toBe(20_000);
    expect(retryBackoffMs(10, 5_000)).toBe(60_000);
  });
});

const WORKER_ENV = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_MODEL: 'approved-local-model',
  OLLAMA_TIMEOUT_MS: 8_000,
  OLLAMA_WORKER_INTERVAL_MS: 5_000,
  OLLAMA_LEASE_MS: 30_000,
  OLLAMA_MAX_ATTEMPTS: 3,
} as Env;

function workerWith(aiSessionSummary: object) {
  const logger = { error: vi.fn() };
  const worker = new AiSummaryWorker({
    prisma: { aiSessionSummary } as never,
    env: WORKER_ENV,
    logger: logger as never,
  });
  return {
    logger,
    runOnce: () => (worker as unknown as { tick(): Promise<void> }).tick(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AI summary worker retry policy', () => {
  it('terminalizes exhausted pending and expired or missing leases', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const findFirst = vi.fn().mockResolvedValue(null);
    const { runOnce } = workerWith({ updateMany, findFirst });

    await runOnce();

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        attemptCount: { gte: 3 },
        OR: [
          { status: 'PENDING' },
          {
            status: 'PROCESSING',
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: expect.any(Date) } }],
          },
        ],
      }),
      data: {
        status: 'UNAVAILABLE',
        leaseToken: null,
        leaseExpiresAt: null,
        unavailableReason: 'OLLAMA_REQUEST_FAILED',
      },
    });
  });

  it('claims expired or missing leases only below the configured attempt maximum', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirst = vi.fn().mockResolvedValue(null);
    const { runOnce } = workerWith({ updateMany, findFirst });

    await runOnce();

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attemptCount: { lt: 3 },
          availableAt: { lte: expect.any(Date) },
          OR: [
            { status: 'PENDING' },
            {
              status: 'PROCESSING',
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: expect.any(Date) } }],
            },
          ],
        }),
      }),
    );
  });

  it('persists backoff after a failed attempt and does not log request content', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private model response')));
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: 'summary-1' })
      .mockResolvedValueOnce({
        id: 'summary-1',
        leaseToken: '00000000-0000-4000-8000-000000000001',
        attemptCount: 1,
        session: {
          mode: 'MOTOR_GRIP',
          completedAt: new Date('2026-07-27T11:30:00.000Z'),
          ruleVersion: { version: 'mvp-1.0.0' },
          result: {
            score: 850,
            metrics: {
              mode: 'MOTOR_GRIP',
              peakGripPercent: 82,
              continuousHoldMs: 5_000,
              targetCompleted: true,
              sessionElapsedMs: 12_400,
            },
          },
        },
      });
    const { logger, runOnce } = workerWith({ updateMany, findFirst });

    await runOnce();

    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: 'PENDING',
          leaseToken: null,
          leaseExpiresAt: null,
          unavailableReason: null,
          availableAt: new Date('2026-07-27T12:00:05.000Z'),
        },
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
