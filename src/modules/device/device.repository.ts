import type { RedisClient } from '../../db/redis.js';
import { readMode3Lock } from '../../device/commands.js';
import {
  MODE3_DEVICE_ID,
  MODE3_DEVICE_LABEL,
  readDeviceReadiness,
  type DeviceReadiness,
} from '../../device/readiness.js';

export interface DeviceRecord {
  readonly deviceId: string;
  readonly label: string;
  readonly inventoryStatus: 'ACTIVE';
  readonly firmwareVersion: string | null;
  readonly capabilitySnapshot: readonly string[];
  readonly reservation: { readonly state: 'HELD' | 'RELEASING' } | null;
}

export interface DeviceSnapshot {
  readonly device: DeviceRecord;
  readonly readiness: DeviceReadiness;
}

export class DeviceRepository {
  constructor(private readonly redis: RedisClient) {}

  async listInstitutionDevices(_institutionId: string): Promise<DeviceSnapshot[]> {
    const [readiness, lock] = await Promise.all([
      readDeviceReadiness(this.redis),
      readMode3Lock(this.redis),
    ]);
    return [
      {
        device: {
          deviceId: MODE3_DEVICE_ID,
          label: MODE3_DEVICE_LABEL,
          inventoryStatus: 'ACTIVE',
          firmwareVersion: readiness.firmwareVersion,
          capabilitySnapshot: readiness.capabilities,
          reservation: lock ? { state: lock.state } : null,
        },
        readiness,
      },
    ];
  }
}
