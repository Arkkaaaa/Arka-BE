import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import type { GameController } from './game.controller.js';
import {
  CreateGameSessionRequestSchema,
  CreatePreparationRequestSchema,
  SessionParamsSchema,
  SessionStatusPatchRequestSchema,
} from './game.validation.js';

export function createGameRoutes(controller: GameController): Router {
  const router = Router();
  router.post(
    '/game-preparations',
    validateBody(CreatePreparationRequestSchema),
    asyncHandler(controller.openPreparation),
  );
  router.post(
    '/game-sessions',
    validateBody(CreateGameSessionRequestSchema),
    asyncHandler(controller.createSession),
  );
  router.patch(
    '/game-sessions/:sessionId/status',
    validateParams(SessionParamsSchema),
    validateBody(SessionStatusPatchRequestSchema),
    asyncHandler(controller.commandSession),
  );
  router.get(
    '/game-sessions/:sessionId',
    validateParams(SessionParamsSchema),
    asyncHandler(controller.getSession),
  );
  return router;
}
