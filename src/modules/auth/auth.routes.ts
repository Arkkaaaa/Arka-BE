import { Router } from 'express';
import type { AuthController } from './auth.controller.js';

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();
  router.get('/me', controller.me);
  return router;
}
