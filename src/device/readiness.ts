import type { Redis } from 'ioredis';
import { z } from 'zod';

const SUPPORTED_DEVICE_FIRMWARE: Readonly<Record<string, true>> = {
  '0.2.0': true,
  '0.2.1': true,
};

export const MODE3_DEVICE_ID = 'mode3-primary';
export const MODE3_DEVICE_LABEL = 'Arka Ding Dong Dong';
export const FSR_DEVICE_LABEL = 'Arka Genggam';

export function deviceLabelForCapabilities(capabilities: unknown): string {
  return Array.isArray(capabilities) && capabilities.includes('FSR_10HZ')
    ? FSR_DEVICE_LABEL
    : MODE3_DEVICE_LABEL;
}
export const MODE3_READINESS_KEY = 'arka:{mode3}:readiness';

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

export const DEVICE_READINESS_TTL_SECONDS = 15;

export function offlineMode3Readiness(): DeviceReadiness {
  return {
    connectionStatus: 'OFFLINE',
    readinessCode: 'OFFLINE',
    firmwareVersion: null,
    capabilities: [],
    batteryPercent: null,
    lastSeenAt: null,
    connectionId: null,
    bootId: null,
  };
}

export async function writeDeviceReadiness(
  redis: Redis,
  readiness: DeviceReadiness,
): Promise<void> {
  const value = DeviceReadinessSchema.parse(readiness);
  await redis.set(
    MODE3_READINESS_KEY,
    JSON.stringify(value),
    'EX',
    DEVICE_READINESS_TTL_SECONDS,
  );
}

export async function readDeviceReadiness(redis: Redis): Promise<DeviceReadiness> {
  let stored: string | null;
  try {
    stored = await redis.get(MODE3_READINESS_KEY);
  } catch {
    return offlineMode3Readiness();
  }
  if (!stored) return offlineMode3Readiness();
  try {
    const parsed: unknown = JSON.parse(stored);
    return DeviceReadinessSchema.parse(parsed);
  } catch {
    return offlineMode3Readiness();
  }
}
