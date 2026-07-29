import type { RequestHandler } from 'express';
import { AppError } from '../../middleware/errors.js';
import type { DashboardService } from './dashboard.service.js';

export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  readonly summary: RequestHandler = async (req, res) => {
    if (!req.authContext)
      throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
    res.json(await this.service.summary(req.authContext.institutionId));
  };
}
