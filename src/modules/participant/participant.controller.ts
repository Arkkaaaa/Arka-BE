import {
  HistoryQuerySchema,
  LeaderboardQuerySchema,
  ResolveParticipantRequestSchema,
  UpdateParticipantRequestSchema,
} from '../../schemas/index.js';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../../middleware/errors.js';
import type { ParticipantService, ParticipantScope } from './participant.service.js';
import { ParticipantParamsSchema } from './participant.validation.js';

function authContext(req: Request): NonNullable<Request['authContext']> {
  if (!req.authContext) throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
  return req.authContext;
}

function participantScope(req: Request): ParticipantScope {
  const auth = authContext(req);
  return {
    institutionId: auth.institutionId,
    actorUserId: auth.userId,
    actorSessionId: auth.sessionId,
    requestId: req.requestId,
  };
}

export class ParticipantController {
  public constructor(private readonly service: ParticipantService) {}

  public readonly resolve: RequestHandler = async (req, res) => {
    const body = ResolveParticipantRequestSchema.parse(req.body);
    res.json(
      await this.service.resolveParticipant(participantScope(req), body.participantReference),
    );
  };

  public readonly get: RequestHandler = async (req, res) => {
    const params = ParticipantParamsSchema.parse(req.params);
    res.json(
      await this.service.getParticipant(authContext(req).institutionId, params.participantId),
    );
  };

  public readonly update: RequestHandler = async (req, res) => {
    const params = ParticipantParamsSchema.parse(req.params);
    const body = UpdateParticipantRequestSchema.parse(req.body);
    res.json(
      await this.service.updateParticipant(participantScope(req), params.participantId, body),
    );
  };

  public readonly history: RequestHandler = async (req, res) => {
    const params = ParticipantParamsSchema.parse(req.params);
    const query = HistoryQuerySchema.parse(req.query);
    res.json(
      await this.service.participantHistory(
        authContext(req).institutionId,
        params.participantId,
        query,
      ),
    );
  };

  public readonly leaderboard: RequestHandler = async (req, res) => {
    const params = ParticipantParamsSchema.parse(req.params);
    const query = LeaderboardQuerySchema.parse(req.query);
    res.json(
      await this.service.participantLeaderboard(
        authContext(req).institutionId,
        params.participantId,
        query.mode,
        query.ruleVersion,
      ),
    );
  };
}
