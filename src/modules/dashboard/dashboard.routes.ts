import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors.js';
import type { DashboardController } from './dashboard.controller.js';

export function createDashboardRoutes(controller: DashboardController): Router {
  const router = Router();
  router.get('/dashboard/summary', asyncHandler(controller.summary));
  return router;
}
