import type { RequestHandler } from 'express';
import { AppError } from '../../middleware/errors.js';
import type { DeviceService } from './device.service.js';
import type { UpdateDeviceRequest } from './device.validation.js';

export class DeviceController {
  constructor(private readonly service: DeviceService) {}

  readonly list: RequestHandler = async (req, res) => {
    if (!req.authContext)
      throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
    const auth = req.authContext;
    res.json(await this.service.list(auth.institutionId));
  };

  readonly update: RequestHandler = async (req, res) => {
    if (!req.authContext)
      throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
    const auth = req.authContext;
    const device = await this.service.update(
      {
        institutionId: auth.institutionId,
        actorUserId: auth.userId,
        actorSessionId: auth.sessionId,
        requestId: req.requestId,
      },
      req.params['deviceId'] as string,
      req.body as UpdateDeviceRequest,
    );
    res.json(device);
  };
}
