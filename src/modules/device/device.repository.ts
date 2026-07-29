import type { RedisClient } from '../../db/redis.js';
import { readDeviceReadiness, type DeviceReadiness } from '../../device/readiness.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { writeAudit, type AuditContext } from '../../services/audit.js';

export interface DeviceRecord {
  readonly deviceId: string;
  readonly label: string;
  readonly inventoryStatus: 'ACTIVE' | 'RETIRED' | 'REVOKED';
  readonly firmwareVersion: string | null;
  readonly capabilitySnapshot: unknown;
  readonly reservation: { readonly state: 'HELD' | 'RELEASING' } | null;
}

export interface DeviceSnapshot {
  readonly device: DeviceRecord;
  readonly readiness: DeviceReadiness;
}

export interface DeviceTransactionRepository {
  findInstitutionDevice(institutionId: string, deviceId: string): Promise<DeviceRecord | null>;
  updateInventory(deviceId: string, inventoryStatus: 'ACTIVE' | 'RETIRED'): Promise<DeviceRecord>;
  recordInventoryUpdate(
    context: AuditContext,
    deviceId: string,
    inventoryStatus: 'ACTIVE' | 'RETIRED',
  ): Promise<void>;
}

const deviceSelection = {
  deviceId: true,
  label: true,
  inventoryStatus: true,
  firmwareVersion: true,
  capabilitySnapshot: true,
  reservation: { select: { state: true } },
} satisfies Prisma.DeviceSelect;

class PrismaDeviceTransactionRepository implements DeviceTransactionRepository {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async findInstitutionDevice(
    institutionId: string,
    deviceId: string,
  ): Promise<DeviceRecord | null> {
    return this.transaction.device.findFirst({
      where: { deviceId, institutionId },
      select: deviceSelection,
    });
  }

  async updateInventory(
    deviceId: string,
    inventoryStatus: 'ACTIVE' | 'RETIRED',
  ): Promise<DeviceRecord> {
    return this.transaction.device.update({
      where: { deviceId },
      data: { inventoryStatus },
      select: deviceSelection,
    });
  }

  async recordInventoryUpdate(
    context: AuditContext,
    deviceId: string,
    inventoryStatus: 'ACTIVE' | 'RETIRED',
  ): Promise<void> {
    await writeAudit(this.transaction, context, {
      action: 'DEVICE_INVENTORY_UPDATED',
      targetType: 'Device',
      targetId: deviceId,
      metadata: { inventoryStatus },
    });
  }
}

export class DeviceRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: RedisClient,
  ) {}

  async listInstitutionDevices(institutionId: string): Promise<DeviceSnapshot[]> {
    const devices = await this.prisma.device.findMany({
      where: { institutionId },
      orderBy: [{ inventoryStatus: 'asc' }, { label: 'asc' }, { deviceId: 'asc' }],
      select: deviceSelection,
    });
    return Promise.all(devices.map((device) => this.snapshot(device)));
  }

  async snapshot(device: DeviceRecord): Promise<DeviceSnapshot> {
    return {
      device,
      readiness: await readDeviceReadiness(this.redis, device.deviceId),
    };
  }

  async transaction<T>(
    operation: (repository: DeviceTransactionRepository) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((transaction) =>
      operation(new PrismaDeviceTransactionRepository(transaction)),
    );
  }
}
