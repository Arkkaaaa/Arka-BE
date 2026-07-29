import type { DeviceRepository, DeviceSnapshot } from '../device/device.repository.js';

export class DashboardRepository {
  constructor(private readonly devices: DeviceRepository) {}

  listInstitutionDeviceSnapshots(institutionId: string): Promise<DeviceSnapshot[]> {
    return this.devices.listInstitutionDevices(institutionId);
  }
}
