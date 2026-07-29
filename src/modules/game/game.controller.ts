import {
  CreateGameSessionResponseSchema,
  GameSessionDtoSchema,
  PreparationDtoSchema,
} from '../../schemas/index.js';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../../middleware/errors.js';
import type { GameRequestContext, GameService } from './game.service.js';
import {
  parseIdempotencyKey,
  type CreateGameSessionRequest,
  type CreatePreparationRequest,
  type SessionStatusPatchRequest,
} from './game.validation.js';

function authenticatedContext(req: Request): NonNullable<Request['authContext']> {
  if (!req.authContext) throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
  return req.authContext;
}

function gameRequestContext(req: Request): GameRequestContext {
  const auth = authenticatedContext(req);
  return {
    institutionId: auth.institutionId,
    userId: auth.userId,
    ownerSessionId: auth.sessionId,
    requestId: req.requestId,
  };
}
function sessionId(req: Request): string {
  return req.params['sessionId'] as string;
}

export class GameController {
  constructor(private readonly service: GameService) {}

  readonly openPreparation: RequestHandler = async (req, res) => {
    const preparation = await this.service.openPreparation(
      gameRequestContext(req),
      req.body as CreatePreparationRequest,
    );
    res.status(201).json(PreparationDtoSchema.parse(preparation));
  };

  readonly createSession: RequestHandler = async (req, res) => {
    const session = await this.service.createSession(
      gameRequestContext(req),
      req.body as CreateGameSessionRequest,
      parseIdempotencyKey(req.get('idempotency-key')),
    );
    res.status(201).json(CreateGameSessionResponseSchema.parse(session));
  };

  readonly commandSession: RequestHandler = async (req, res) => {
    const session = await this.service.commandSession(
      gameRequestContext(req),
      sessionId(req),
      req.body as SessionStatusPatchRequest,
    );
    res.json(GameSessionDtoSchema.parse(session));
  };

  readonly getSession: RequestHandler = async (req, res) => {
    const auth = authenticatedContext(req);
    const session = await this.service.getSession(auth.institutionId, sessionId(req));
    res.json(GameSessionDtoSchema.parse(session));
  };
}
