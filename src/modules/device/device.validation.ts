import { DeviceDtoSchema, UpdateDeviceRequestSchema, type DeviceDto } from '../../schemas/index.js';
import { z } from 'zod';

export const DeviceParamsSchema = z.object({
  deviceId: z.string().min(3).max(80),
});

export { DeviceDtoSchema, UpdateDeviceRequestSchema };
export type { DeviceDto };
export type DeviceParams = z.infer<typeof DeviceParamsSchema>;
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequestSchema>;
