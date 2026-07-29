import { Router } from 'express';
import type { AuthController } from './auth.controller.js';

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();
  router.get('/me', controller.me);
  router.get('/auth/onboarding', controller.onboardingStatus);
  router.post('/auth/onboarding', controller.completeOnboarding);
  return router;
}
