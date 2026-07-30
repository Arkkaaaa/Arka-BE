import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../middleware/errors.js';
import { validateBody } from '../../middleware/validate.js';
import { UpdateProfileRequestSchema } from '../../schemas/index.js';
import type { ProfileController } from './profile.controller.js';

export function createProfileRoutes(
  controller: ProfileController,
  mutationActivity: RequestHandler,
): Router {
  const router = Router();
  router.patch(
    '/profile',
    mutationActivity,
    validateBody(UpdateProfileRequestSchema),
    asyncHandler(controller.update),
  );
  return router;
}
