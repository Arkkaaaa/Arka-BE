import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import type { ParticipantController } from './participant.controller.js';
import {
  CreateParticipantRequestSchema,
  HistoryQuerySchema,
  LeaderboardQuerySchema,
  ParticipantParamsSchema,
  ParticipantSearchQuerySchema,
  ResolveParticipantRequestSchema,
  UpdateParticipantRequestSchema,
} from './participant.validation.js';

export function createParticipantRouter(controller: ParticipantController): Router {
  const router = Router();

  router.get(
    '/participants',
    validateQuery(ParticipantSearchQuerySchema),
    asyncHandler(controller.search),
  );
  router.post(
    '/participants',
    validateBody(CreateParticipantRequestSchema),
    asyncHandler(controller.create),
  );
  router.post(
    '/participants/resolve',
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
