import { MeDtoSchema } from '../../schemas/index.js';
import type { RequestHandler } from 'express';
import { AppError } from '../../middleware/errors.js';
import { csrfToken } from '../../middleware/security.js';

export class AuthController {
  public readonly me: RequestHandler;

  public constructor(private readonly betterAuthSecret: string) {
    this.me = (req, res) => {
      const auth = req.authContext;
      if (!auth) {
        throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
      }

      res.json(
        MeDtoSchema.parse({
          user: {
            id: auth.userId,
            email: auth.email,
            name: auth.name,
            image: auth.image,
          },
          institution: {
            id: auth.institutionId,
            name: auth.institutionName,
            status: 'ACTIVE',
          },
          session: { id: auth.sessionId, expiresAt: auth.sessionExpiresAt.toISOString() },
          csrfToken: csrfToken(auth.sessionId, this.betterAuthSecret),
        }),
      );
    };
  }
}
