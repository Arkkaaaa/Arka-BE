import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../middleware/errors.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import type { DeviceController } from './device.controller.js';
import { DeviceParamsSchema, UpdateDeviceRequestSchema } from './device.validation.js';

export function createDeviceRoutes(
  controller: DeviceController,
  mutationActivity: RequestHandler,
): Router {
  const router = Router();
  router.get('/devices', asyncHandler(controller.list));
  router.patch(
    '/devices/:deviceId',
    mutationActivity,
    validateParams(DeviceParamsSchema),
    validateBody(UpdateDeviceRequestSchema),
    asyncHandler(controller.update),
  );
  return router;
}
