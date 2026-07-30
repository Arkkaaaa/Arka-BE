import { createServer } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { toNodeHandler } from 'better-auth/node';
import { createAuth } from './auth/auth.js';
import { buildAuthCapabilities } from './auth/capabilities.js';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';
import { getPrisma } from './db/prisma.js';
import { closeHttpServer } from './lifecycle.js';
import { connectRedis, createRedis, isRedisConnected } from './db/redis.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { rateLimit } from './middleware/rate-limit.js';
import { prettyHttpLogger } from './middleware/http-logger.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import {
  authenticate,
  exactOriginGuard,
  protectAuthMutation,
  requireCsrf,
} from './middleware/security.js';
import { AuthRepository } from './modules/auth/auth.repository.js';
import { SessionActivityService } from './modules/auth/auth.service.js';
import { createRealtimeAttachment } from './realtime/index.js';
import { createApiRouter } from './routes/api.js';
import { createSwaggerRouter } from './routes/swagger.js';
import { createAiSummaryWorker } from './workers/ai-summary.js';
import { createOutboxWorker } from './workers/outbox.js';

const logger = createLogger(env);
const prisma = getPrisma(env);
const redis = createRedis(env, logger);
const auth = createAuth(prisma, env);
const sessionActivity = new SessionActivityService(new AuthRepository(prisma, redis), logger);
const validateSession = sessionActivity.validate.bind(sessionActivity);
const realtime = createRealtimeAttachment({
  prisma,
  redis,
  auth,
  env,
  logger,
  validateSession,
});
const aiSummaryWorker = createAiSummaryWorker({ prisma, env, logger });
const outboxWorker = createOutboxWorker({ prisma, env, logger });
const app = express();
const server = createServer(app);
const authHandler = toNodeHandler(auth);

sessionActivity.attachRuntimeExpirer(realtime.runtime.expireOwnerSession.bind(realtime.runtime));
sessionActivity.attachSocketRevoker(realtime.revokeSession.bind(realtime));

app.disable('x-powered-by');
app.use(requestIdMiddleware);
app.use(
  pinoHttp({
    logger,
    genReqId: (request) =>
      (request as typeof request & { requestId?: string }).requestId ?? 'request-id-unavailable',
    autoLogging: false,
  }),
);
app.use(prettyHttpLogger);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        connectSrc: ["'self'"],
      },
    },
  }),
);
app.use(exactOriginGuard(env));
app.use(createSwaggerRouter());

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', async (_req, res) => {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    if (!isRedisConnected(redis) || (await redis.ping()) !== 'PONG')
      throw new Error('Redis unavailable');
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.all(
  '/api/auth/*splat',
  rateLimit(redis, { namespace: 'auth', limit: 20, windowSeconds: 60 }),
  protectAuthMutation(
    auth,
    env.BETTER_AUTH_SECRET,
    sessionActivity.prepareRevocation.bind(sessionActivity),
  ),
  (req, res, next) => void authHandler(req, res).catch(next),
);

app.use(express.json({ limit: '64kb', strict: true, type: 'application/json' }));
app.get('/api/v1/auth/capabilities', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).json(buildAuthCapabilities(env));
});
app.use(
  '/api/v1',
  authenticate(auth, prisma, validateSession),
  requireCsrf(env.BETTER_AUTH_SECRET),
  rateLimit(redis, { namespace: 'api', limit: 120, windowSeconds: 60 }),
  createApiRouter({
    prisma,
    redis,
    env,
    runtime: realtime.runtime,
    touchSession: sessionActivity.touch.bind(sessionActivity),
  }),
);
app.use(notFoundHandler);
app.use(errorHandler(logger));

server.on('upgrade', (request, socket, head) => {
  if (!realtime.handleUpgrade(request, socket, head) && !socket.destroyed) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Backend shutdown started');
  sessionActivity.stop();
  const serverClosed = closeHttpServer(server, 10_000);
  await Promise.allSettled([
    serverClosed,
    realtime.close(),
    aiSummaryWorker.stop(),
    outboxWorker.stop(),
  ]);
  await Promise.allSettled([redis.quit(), prisma.$disconnect()]);
  logger.info('Backend shutdown completed');
}

async function start(): Promise<void> {
  await connectRedis(redis);
  await prisma.$queryRawUnsafe('SELECT 1');
  await realtime.recover();
  sessionActivity.start();
  aiSummaryWorker.start();
  outboxWorker.start();

  const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(env.PORT, env.HOST, resolve);
  await listening;
  server.removeListener('error', reject);
  logger.info({ host: env.HOST, port: env.PORT }, 'Backend ready');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

void start().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Backend startup failed');
  await shutdown('STARTUP_FAILURE');
  process.exitCode = 1;
});
