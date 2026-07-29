import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  DeviceReadinessSchema,
  readDeviceReadiness,
  writeDeviceReadiness,
} from '../device/readiness.js';
import { writeAudit } from './audit.js';
import { DeviceRepository, DeviceService } from '../modules/device/index.js';

const INSTITUTION_ID = '018f2f6e-7b23-7f6b-9238-0242ac120003';

describe('audit privacy boundary', () => {
  it('recursively redacts sensitive metadata before persistence', async () => {
    let persisted: unknown;
    const db = {
      auditLog: {
        create: (input: unknown) => {
          persisted = input;
          return Promise.resolve(input);
        },
      },
    };

    await writeAudit(
      db as never,
      { institutionId: 'institution-1', requestId: 'request-1' },
      {
        action: 'SESSION_FINALIZED',
        targetType: 'GameSession',
        targetId: 'session-1',
        metadata: {
          score: 850,
          nested: {
            accessToken: 'must-not-persist',
            participant_reference: 'must-not-persist',
            safe: ['retained', { fsrRaw: 3_000 }],
          },
        },
      },
    );

    expect(persisted).toEqual({
      data: {
        institutionId: 'institution-1',
        requestId: 'request-1',
        action: 'SESSION_FINALIZED',
        targetType: 'GameSession',
        targetId: 'session-1',
        outcome: 'SUCCESS',
        metadata: {
          score: 850,
          nested: {
            accessToken: '[REDACTED]',
            participant_reference: '[REDACTED]',
            safe: ['retained', { fsrRaw: '[REDACTED]' }],
          },
        },
      },
    });
  });
});

describe('device readiness boundary', () => {
  const online = {
    connectionStatus: 'ONLINE' as const,
    readinessCode: 'READY' as const,
    firmwareVersion: '0.1.0',
    capabilities: ['FSR_10HZ', 'LED'],
    batteryPercent: 80,
    lastSeenAt: '2026-07-26T01:00:00.000Z',
    connectionId: '018f2f6e-7b23-7f6b-9238-0242ac120010',
    bootId: '018f2f6e-7b23-7f6b-9238-0242ac120011',
  };

  it('writes readiness with its bounded Redis TTL', async () => {
    const calls: unknown[][] = [];
    const redis = {
      set: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve('OK');
      },
    } as unknown as Redis;

    await writeDeviceReadiness(redis, 'jalin-demo-001', online);

    expect(calls).toEqual([
      ['jalin:device:readiness:jalin-demo-001', JSON.stringify(online), 'EX', 20],
    ]);
  });

  it.each([
    ['unsupported', '1.0.0'],
    ['missing', null],
  ])('rejects %s firmware from ONLINE and READY state', (_label, firmwareVersion) => {
    expect(() =>
      DeviceReadinessSchema.parse({
        ...online,
        firmwareVersion,
      }),
    ).toThrow();
  });

  it.each([
    ['missing', null],
    ['corrupt JSON', '{'],
    ['invalid schema', JSON.stringify({ connectionStatus: 'ONLINE' })],
  ])('fails closed to OFFLINE for %s Redis state', async (_label, stored) => {
    const redis = { get: () => Promise.resolve(stored) } as unknown as Redis;
    await expect(readDeviceReadiness(redis, 'jalin-demo-001')).resolves.toEqual({
      connectionStatus: 'OFFLINE',
      readinessCode: 'OFFLINE',
      firmwareVersion: null,
      capabilities: [],
      batteryPercent: null,
      lastSeenAt: null,
      connectionId: null,
      bootId: null,
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    const redis = {
      get: () => Promise.reject(new Error('redis unavailable')),
    } as unknown as Redis;
    await expect(readDeviceReadiness(redis, 'jalin-demo-001')).resolves.toMatchObject({
      connectionStatus: 'OFFLINE',
      readinessCode: 'OFFLINE',
    });
  });

  it('keeps incompatible firmware visible despite an existing reservation', async () => {
    const incompatible = {
      ...online,
      connectionStatus: 'CONNECTING' as const,
      readinessCode: 'NOT_COMPATIBLE' as const,
      firmwareVersion: '1.0.0',
    };
    const redis = {
      get: () => Promise.resolve(JSON.stringify(incompatible)),
    } as unknown as Redis;
    const prisma = {
      device: {
        findMany: () =>
          Promise.resolve([
            {
              deviceId: 'jalin-demo-001',
              label: 'Perangkat Demo',
              inventoryStatus: 'ACTIVE',
              firmwareVersion: '1.0.0',
              capabilitySnapshot: ['FSR_10HZ', 'LED'],
              reservation: { state: 'HELD' },
            },
          ]),
      },
    };

    await expect(
      new DeviceService(new DeviceRepository(prisma as never, redis)).list(INSTITUTION_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        connectionStatus: 'CONNECTING',
        readinessCode: 'NOT_COMPATIBLE',
      }),
    ]);
  });
});
