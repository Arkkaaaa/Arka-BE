import type { Redis } from 'ioredis';
import { z } from 'zod';

const SUPPORTED_DEVICE_FIRMWARE: Readonly<Record<string, true>> = {
  '0.1.0': true,
};

export function isDeviceFirmwareCompatible(firmwareVersion: string): boolean {
  return SUPPORTED_DEVICE_FIRMWARE[firmwareVersion] === true;
}

export const DeviceConnectionStatusSchema = z.enum([
  'ONLINE',
  'OFFLINE',
  'CONNECTING',
  'NOT_AUTHORIZED',
]);
export const DeviceReadinessCodeSchema = z.enum([
  'READY',
  'OFFLINE',
  'NOT_ACTIVE',
  'NOT_COMPATIBLE',
  'RESERVED',
  'CLEANUP_PENDING',
  'NOT_READY_BATTERY_UNKNOWN',
  'NOT_READY_LOW_BATTERY',
  'DEVICE_FAULT',
]);

export const DeviceReadinessSchema = z
  .object({
    connectionStatus: DeviceConnectionStatusSchema,
    readinessCode: DeviceReadinessCodeSchema,
    firmwareVersion: z.string().max(80).nullable(),
    capabilities: z.array(z.string().max(40)).max(16),
    batteryPercent: z.number().int().min(0).max(100).nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    connectionId: z.string().uuid().nullable(),
    bootId: z.string().uuid().nullable(),
  })
  .strict()
  .superRefine((readiness, context) => {
    const firmwareCompatible =
      readiness.firmwareVersion !== null && isDeviceFirmwareCompatible(readiness.firmwareVersion);
    if (readiness.connectionStatus === 'ONLINE' && !firmwareCompatible) {
      context.addIssue({
        code: 'custom',
        path: ['connectionStatus'],
        message: 'Online devices require supported firmware',
      });
    }
    if (readiness.readinessCode === 'READY' && !firmwareCompatible) {
      context.addIssue({
        code: 'custom',
        path: ['readinessCode'],
        message: 'Ready devices require supported firmware',
      });
    }
    if (
      readiness.firmwareVersion !== null &&
      !firmwareCompatible &&
      readiness.readinessCode !== 'NOT_COMPATIBLE'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['readinessCode'],
        message: 'Unsupported firmware must be marked not compatible',
      });
    }
  });
export type DeviceReadiness = z.infer<typeof DeviceReadinessSchema>;

export const DEVICE_READINESS_TTL_SECONDS = 20;

export function readinessRedisKey(deviceId: string): string {
  return `jalin:device:readiness:${deviceId}`;
}

export async function writeDeviceReadiness(
  redis: Redis,
  deviceId: string,
  readiness: DeviceReadiness,
): Promise<void> {
  const value = DeviceReadinessSchema.parse(readiness);
  await redis.set(
    readinessRedisKey(deviceId),
    JSON.stringify(value),
    'EX',
    DEVICE_READINESS_TTL_SECONDS,
  );
}

export async function readDeviceReadiness(
  redis: Redis,
  deviceId: string,
): Promise<DeviceReadiness> {
  const offline: DeviceReadiness = {
    connectionStatus: 'OFFLINE',
    readinessCode: 'OFFLINE',
    firmwareVersion: null,
    capabilities: [],
    batteryPercent: null,
    lastSeenAt: null,
    connectionId: null,
    bootId: null,
  };
  let stored: string | null;
  try {
    stored = await redis.get(readinessRedisKey(deviceId));
  } catch {
    return offline;
  }
  if (!stored) return offline;
  try {
    const parsed: unknown = JSON.parse(stored);
    return DeviceReadinessSchema.parse(parsed);
  } catch {
    return offline;
  }
}
