import { Router } from 'express';
import type { Env } from '../config/env.js';
import type { RedisClient } from '../db/redis.js';
import type { PrismaClient } from '../generated/prisma/client.js';

import { requireInstitution } from '../middleware/security.js';
import { AuthController } from '../modules/auth/auth.controller.js';
import { createAuthRouter } from '../modules/auth/auth.routes.js';
import {
  DashboardController,
  DashboardRepository,
  DashboardService,
  createDashboardRoutes,
} from '../modules/dashboard/index.js';
import {
  DeviceController,
  DeviceRepository,
  DeviceService,
  createDeviceRoutes,
} from '../modules/device/index.js';
import { GameController } from '../modules/game/game.controller.js';
import { GameRepository } from '../modules/game/game.repository.js';
import { createGameRoutes } from '../modules/game/game.routes.js';
import { GameService } from '../modules/game/game.service.js';
import { ParticipantController } from '../modules/participant/participant.controller.js';
import { ParticipantRepository } from '../modules/participant/participant.repository.js';
import { createParticipantRouter } from '../modules/participant/participant.routes.js';
import { ParticipantService } from '../modules/participant/participant.service.js';
import {
  ProfileController,
  ProfileRepository,
  ProfileService,
  createProfileRoutes,
} from '../modules/profile/index.js';
import type { RuntimeGateway } from '../realtime/index.js';
import { writeAudit } from '../services/audit.js';
import { PdfReportService } from '../services/pdf-report.js';

export interface ApiRouterDependencies {
  readonly prisma: PrismaClient;
  readonly redis: RedisClient;
  readonly env: Env;
  readonly runtime: RuntimeGateway;
}

export function createApiRouter(dependencies: ApiRouterDependencies): Router {
  const router = Router();

  const authController = new AuthController(dependencies.env.BETTER_AUTH_SECRET, dependencies.prisma);
  const participantService = new ParticipantService(
    new ParticipantRepository(dependencies.prisma),
    dependencies.env.BETTER_AUTH_SECRET,
  );
  const gameService = new GameService(
    new GameRepository(dependencies.prisma),
    dependencies.runtime,
    (context, event) => writeAudit(dependencies.prisma, context, event),
  );
  const pdfReportService = new PdfReportService(
    participantService,
    gameService,
    (context, event) => writeAudit(dependencies.prisma, context, event),
  );
  const participantController = new ParticipantController(participantService, pdfReportService);
  const profileController = new ProfileController(
    new ProfileService(new ProfileRepository(dependencies.prisma)),
  );
  const deviceRepository = new DeviceRepository(dependencies.redis);
  const deviceController = new DeviceController(new DeviceService(deviceRepository));
  const dashboardController = new DashboardController(
    new DashboardService(new DashboardRepository(dependencies.prisma, deviceRepository)),
  );
  const gameController = new GameController(gameService, pdfReportService);

  router.use(createAuthRouter(authController));
  router.use(requireInstitution);
  router.use(createProfileRoutes(profileController));
  router.use(createParticipantRouter(participantController, dependencies.redis));
  router.use(createDeviceRoutes(deviceController));
  router.use(createGameRoutes(gameController, dependencies.redis));
  router.use(createDashboardRoutes(dashboardController));
  return router;
}
