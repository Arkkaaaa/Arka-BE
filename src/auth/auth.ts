import { betterAuth, getCurrentAdapter } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { openAPI } from 'better-auth/plugins';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  InstitutionNameError,
  validateRegistrationInstitutionName,
} from './institution-provisioning.js';

export interface AuthSession {
  session: { id: string; expiresAt: Date };
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null | undefined;
    institutionId?: string | null | undefined;
  };
}

export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<AuthSession | null>;
    getSession(input: {
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers; response: AuthSession | null }>;
  };
}

export function createAuth(prisma: PrismaClient, env: Env): Auth {
  return betterAuth({
    appName: 'Arka',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [...env.browserOrigins],
    database: prismaAdapter(prisma, { provider: 'postgresql', transaction: true }),
    plugins: [openAPI({ disableDefaultReference: true })],
    hooks: {
      before: createAuthMiddleware((context) => {
        if (context.path !== '/sign-up/email') return Promise.resolve();
        try {
          const body: unknown = context.body;
          if (typeof body !== 'object' || body === null || !('name' in body)) {
            throw new InstitutionNameError();
          }
          body.name = validateRegistrationInstitutionName(body.name);
          return Promise.resolve();
        } catch (error) {
          if (error instanceof InstitutionNameError) {
            return Promise.reject(
              APIError.from('BAD_REQUEST', {
                code: 'INSTITUTION_NAME_INVALID',
                message: 'Nama institusi harus terdiri dari 2-120 karakter.',
              }),
            );
          }
          throw error;
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    ...(env.googleOAuth === null
      ? {}
      : {
          socialProviders: {
            google: {
              clientId: env.googleOAuth.clientId,
              clientSecret: env.googleOAuth.clientSecret,
              redirectURI: new URL('/api/auth/callback/google', env.BETTER_AUTH_URL).toString(),
              disableImplicitSignUp: true,
            },
          },
        }),
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            if (!context) {
              throw APIError.from('INTERNAL_SERVER_ERROR', {
                code: 'AUTH_CONTEXT_MISSING',
                message: 'Akun belum dapat dibuat.',
              });
            }
            if (context.path !== '/sign-up/email') {
              return { data: { ...user, institutionId: null } };
            }
            const institutionName = validateRegistrationInstitutionName(user.name);
            const adapter = await getCurrentAdapter(context.context.adapter);
            const institution = await adapter.create<
              { name: string; status: 'ACTIVE' },
              { id: string }
            >({
              model: 'institution',
              data: { name: institutionName, status: 'ACTIVE' },
              select: ['id'],
            });
            return {
              data: {
                ...user,
                name: institutionName,
                institutionId: institution.id,
              },
            };
          },
        },
      },
    },
    user: {
      additionalFields: {
        institutionId: {
          type: 'string',
          required: false,
          input: false,
          returned: true,
        },
      },
    },
    session: {
      expiresIn: 8 * 60 * 60,
      updateAge: 15 * 60,
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      },
    },
  });
}
