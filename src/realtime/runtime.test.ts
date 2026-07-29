import { describe, expect, it, vi } from 'vitest';
import { AuthoritativeRuntime, type TrustedDeviceInput } from './runtime.js';

function logger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

function expiredPreparationHarness() {
  let state: 'CALIBRATING' | 'EXPIRED' = 'CALIBRATING';
  const expiresAt = new Date(Date.now() - 1_000);
  const setupId = '00000000-0000-4000-8000-000000000001';
  const commandId = '00000000-0000-4000-8000-000000000002';
  const reservation = {
    reservationId: '00000000-0000-4000-8000-000000000003',
  };
  const tx = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    gamePreparation: {
      updateMany: vi.fn(
        ({ where, data }: { where: { expiresAt?: { lte: Date } }; data: { state: 'EXPIRED' } }) => {
          const canExpire =
            state !== 'EXPIRED' && (where.expiresAt?.lte ?? new Date(0)) >= expiresAt;
          if (!canExpire) return Promise.resolve({ count: 0 });
          state = data.state;
          return Promise.resolve({ count: 1 });
        },
      ),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        setupId,
        deviceId: 'device-1',
        reservation,
      }),
    },
    deviceCommand: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ commandId }),
    },
    deviceReservation: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    gameSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    gamePreparation: {
      findMany: vi.fn(() => Promise.resolve(state === 'EXPIRED' ? [] : [{ setupId, expiresAt }])),
    },
    deviceReservation: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
  };
  const redis = { get: vi.fn().mockResolvedValue(null), del: vi.fn().mockResolvedValue(1) };
  const runtime = new AuthoritativeRuntime({ prisma, redis, logger: logger() } as never);
  vi.spyOn(runtime.events, 'publish').mockResolvedValue(undefined as never);
  return { runtime, prisma, redis, tx, setupId, commandId, getState: () => state };
}

function trustedInput(sequence: number): TrustedDeviceInput {
  return {
    receivedAtMs: sequence,
    connectionId: 'connection-1',
    bootId: 'boot-1',
    messageId: `message-${sequence}`,
    sequence,
    sentAtMs: sequence,
  };
}

describe('preparation expiry lifecycle', () => {
  it('expires and fences cleanup for an expired preparation after runtime state loss', async () => {
    const harness = expiredPreparationHarness();

    await harness.runtime.recover();
    await harness.runtime.stop();

    expect(harness.getState()).toBe('EXPIRED');
    expect(harness.tx.deviceCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deviceId: 'device-1',
        reservationId: '00000000-0000-4000-8000-000000000003',
        associationId: harness.setupId,
        kind: 'SETUP_UNBIND',
        payload: { reason: 'PREPARATION_EXPIRED' },
      }),
    });
    expect(harness.tx.deviceReservation.update).toHaveBeenCalledWith({
      where: { deviceId: 'device-1' },
      data: { state: 'RELEASING', releaseCommandId: harness.commandId },
    });
    expect(harness.prisma.deviceReservation.deleteMany).not.toHaveBeenCalled();
    expect(harness.redis.del).toHaveBeenCalledWith(`jalin:runtime:setup:${harness.setupId}`);
  });

  it('sweeps live expired preparations idempotently and releases only after matching unbind ACK', async () => {
    const harness = expiredPreparationHarness();
    const tick = harness.runtime as unknown as { tick(): Promise<void> };

    await tick.tick();
    await tick.tick();

    expect(harness.tx.deviceCommand.create).toHaveBeenCalledOnce();
    expect(harness.prisma.deviceReservation.deleteMany).not.toHaveBeenCalled();

    await harness.runtime.handleSetupUnbound(harness.setupId, harness.commandId);

    expect(harness.prisma.deviceReservation.deleteMany).toHaveBeenCalledWith({
      where: {
        state: 'RELEASING',
        releaseCommandId: harness.commandId,
        preparation: { setupId: harness.setupId },
      },
    });
  });
});

describe('preparation calibration storage', () => {
  it('keeps only configured fixed windows while calibration remains incomplete', async () => {
    const setupId = '00000000-0000-4000-8000-000000000010';
    let encoded = JSON.stringify({
      preparationId: 'preparation-1',
      setupId,
      mode: 'MOTOR_GRIP',
      deviceId: 'device-1',
      config: {
        baselineMinimumSamples: 2,
        activeMinimumSamples: 3,
        minimumDeltaRaw: 4_095,
        calibratedPercentile: 0.9,
        sustainThreshold: 30,
        targetHoldMs: 5_000,
        sessionDurationMs: 30_000,
        telemetryGapMs: 300,
      },
      state: 'CALIBRATING',
      setupBound: true,
      calibrationState: { baselineWindow: [], activeWindow: [] },
      calibration: null,
      edge: { pressed: false, armed: true },
      practice: [],
      practiceIndex: 0,
      practicePressed: false,
      practiceDeadlineMs: null,
      lastInput: null,
    });
    const redis = {
      get: vi.fn(() => Promise.resolve(encoded)),
      set: vi.fn((_key: string, value: string) => {
        encoded = value;
        return Promise.resolve('OK');
      }),
    };
    const runtime = new AuthoritativeRuntime({ prisma: {}, redis, logger: logger() } as never);
    vi.spyOn(runtime.events, 'publish').mockResolvedValue(undefined as never);

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      await runtime.handleFsr({ setupId }, 100, trustedInput(sequence));
    }

    const stored = JSON.parse(encoded) as {
      calibrationState: { baselineWindow: number[]; activeWindow: number[] };
      baselineSamples?: unknown;
      activeSamples?: unknown;
    };
    expect(stored.calibrationState.baselineWindow).toHaveLength(2);
    expect(stored.calibrationState.activeWindow).toHaveLength(3);
    expect(stored).not.toHaveProperty('baselineSamples');
    expect(stored).not.toHaveProperty('activeSamples');
  });

  it('discards calibration windows as soon as calibration completes', async () => {
    const setupId = '00000000-0000-4000-8000-000000000020';
    let encoded = JSON.stringify({
      preparationId: 'preparation-2',
      setupId,
      mode: 'MOTOR_GRIP',
      deviceId: 'device-1',
      config: {
        baselineMinimumSamples: 2,
        activeMinimumSamples: 2,
        minimumDeltaRaw: 200,
        calibratedPercentile: 0.9,
        sustainThreshold: 30,
        targetHoldMs: 5_000,
        sessionDurationMs: 30_000,
        telemetryGapMs: 300,
      },
      state: 'CALIBRATING',
      setupBound: true,
      calibrationState: { baselineWindow: [], activeWindow: [] },
      calibration: null,
      edge: { pressed: false, armed: true },
      practice: [],
      practiceIndex: 0,
      practicePressed: false,
      practiceDeadlineMs: null,
      lastInput: null,
    });
    const redis = {
      get: vi.fn(() => Promise.resolve(encoded)),
      set: vi.fn((_key: string, value: string) => {
        encoded = value;
        return Promise.resolve('OK');
      }),
    };
    const prisma = {
      gamePreparation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const runtime = new AuthoritativeRuntime({ prisma, redis, logger: logger() } as never);
    vi.spyOn(runtime.events, 'publish').mockResolvedValue(undefined as never);

    for (const [index, sample] of [100, 100, 500, 500].entries()) {
      await runtime.handleFsr({ setupId }, sample, trustedInput(index + 1));
    }

    const stored = JSON.parse(encoded) as {
      state: string;
      calibrationState: unknown;
      calibration: Record<string, unknown>;
    };
    expect(stored.state).toBe('READY');
    expect(stored.calibrationState).toBeNull();
    expect(stored.calibration).toEqual({ baselineRaw: 100, calibratedMaxRaw: 500 });
    expect(stored.calibration).not.toHaveProperty('deltaRaw');
    expect(stored.calibration).not.toHaveProperty('valid');
  });

  it('rejects malformed or out-of-range FSR samples before retaining them', async () => {
    const redis = { get: vi.fn(), set: vi.fn() };
    const runtime = new AuthoritativeRuntime({ prisma: {}, redis, logger: logger() } as never);

    await expect(
      runtime.handleFsr(
        { setupId: '00000000-0000-4000-8000-000000000030' },
        4_096,
        trustedInput(1),
      ),
    ).rejects.toThrow('FSR telemetry must be an integer from 0 through 4095');
    await expect(
      runtime.handleFsr({ setupId: '00000000-0000-4000-8000-000000000030' }, 1.5, trustedInput(2)),
    ).rejects.toThrow('FSR telemetry must be an integer from 0 through 4095');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});

describe('durable finalization recovery', () => {
  it('keeps transient persistence failures leased for retry instead of terminalizing them', async () => {
    let status = 'COMPLETED';
    const gameSession = {
      updateMany: vi.fn(({ data }: { data: { status: string } }) => {
        status = data.status;
        return Promise.resolve({ count: 1 });
      }),
    };
    const prisma = {
      gameSession,
      $transaction: vi.fn().mockRejectedValue(new Error('database temporarily unavailable')),
    };
    const runtime = new AuthoritativeRuntime({
      prisma,
      redis: {},
      logger: logger(),
    } as never) as unknown as {
      persistFinalization(sessionId: string): Promise<'SAVED' | 'SAVE_FAILED' | null>;
    };

    await expect(runtime.persistFinalization('session-1')).resolves.toBeNull();
    expect(status).toBe('SAVING');
    expect(gameSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([expect.objectContaining({ status: 'COMPLETED' })]),
          finalizationRecoveryExpiresAt: expect.anything(),
        }),
        data: expect.objectContaining({
          status: 'SAVING',
          finalizationLeaseToken: expect.any(String),
          finalizationLeaseExpiresAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('terminalizes an expired recovery deadline with one audit and outbox alert', async () => {
    const auditLog = { create: vi.fn().mockResolvedValue({}) };
    const outboxEvent = { create: vi.fn().mockResolvedValue({}) };
    const tx = {
      gameSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ institutionId: 'institution-1' }),
      },
      auditLog,
      outboxEvent,
    };
    const prisma = {
      gameSession: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'COMPLETED',
          finalizationRecoveryExpiresAt: new Date(0),
          finalizationLeaseExpiresAt: null,
          result: null,
        }),
      },
      $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        Promise.resolve(callback(tx)),
      ),
    };
    const runtime = new AuthoritativeRuntime({
      prisma,
      redis: {},
      logger: logger(),
    } as never) as unknown as {
      recoverFinalization(sessionId: string): Promise<'SAVED' | 'SAVE_FAILED' | null>;
    };

    await expect(runtime.recoverFinalization('session-2')).resolves.toBe('SAVE_FAILED');
    expect(auditLog.create).toHaveBeenCalledOnce();
    expect(outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventKey: 'session-finalization-failed:session-2',
        type: 'SESSION_FINALIZATION_FAILED',
        payload: expect.objectContaining({
          institutionId: 'institution-1',
          sessionId: 'session-2',
          failureCode: 'FINALIZATION_RECOVERY_EXPIRED',
        }),
      }),
    });
  });
});
