import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../middleware/errors.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import type { ParticipantController } from './participant.controller.js';
import {
  HistoryQuerySchema,
  LeaderboardQuerySchema,
  ParticipantParamsSchema,
  ResolveParticipantRequestSchema,
  UpdateParticipantRequestSchema,
} from './participant.validation.js';

export function createParticipantRouter(
  controller: ParticipantController,
  mutationActivity: RequestHandler,
): Router {
  const router = Router();

  router.post(
    '/participants/resolve',
    mutationActivity,
    validateBody(ResolveParticipantRequestSchema),
    asyncHandler(controller.resolve),
  );
  router.get(
    '/participants/:participantId',
    validateParams(ParticipantParamsSchema),
    asyncHandler(controller.get),
  );
  router.patch(
    '/participants/:participantId',
    mutationActivity,
    validateParams(ParticipantParamsSchema),
    validateBody(UpdateParticipantRequestSchema),
    asyncHandler(controller.update),
  );
  router.get(
    '/participants/:participantId/sessions',
    validateParams(ParticipantParamsSchema),
    validateQuery(HistoryQuerySchema),
    asyncHandler(controller.history),
  );
  router.get(
    '/participants/:participantId/leaderboard',
    validateParams(ParticipantParamsSchema),
    validateQuery(LeaderboardQuerySchema),
    asyncHandler(controller.leaderboard),
  );

  return router;
}
