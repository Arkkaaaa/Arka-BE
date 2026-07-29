import { mapDeviceSnapshot } from '../device/device.service.js';
import type { DashboardRepository } from './dashboard.repository.js';
import {
  DashboardActivityDtoSchema,
  DashboardSummaryDtoSchema,
  type DashboardActivityDto,
  type DashboardSummaryDto,
} from './dashboard.validation.js';

export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}

  async activity(institutionId: string): Promise<DashboardActivityDto> {
    const activity = await this.repository.activity(institutionId);
    return DashboardActivityDtoSchema.parse({
      ...activity,
      latestSavedAt: activity.latestSavedAt?.toISOString() ?? null,
      modes: activity.modes.map((mode) => ({
        ...mode,
        latestSavedAt: mode.latestSavedAt?.toISOString() ?? null,
      })),
    });
  }

  async summary(institutionId: string): Promise<DashboardSummaryDto> {
    const snapshots = await this.repository.listInstitutionDeviceSnapshots(institutionId);
    const devices = snapshots.map(mapDeviceSnapshot);
    const readyDevices = devices.filter((device) => device.readinessCode === 'READY').length;
    const onlineDevices = devices.filter((device) => device.connectionStatus === 'ONLINE').length;
    const totalActiveDevices = devices.filter(
      (device) => device.inventoryStatus === 'ACTIVE',
    ).length;
    const readinessMessage =
      readyDevices > 0
        ? `${readyDevices} perangkat siap digunakan.`
        : totalActiveDevices === 0
          ? 'Belum ada perangkat aktif untuk institusi ini.'
          : 'Belum ada perangkat yang siap digunakan.';
    return DashboardSummaryDtoSchema.parse({
      readyDevices,
      onlineDevices,
      totalActiveDevices,
      readinessMessage,
    });
  }
}
