import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Auth } from '../auth/auth.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { AppError, asyncHandler } from './errors.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requestHeaders(headers: NodeJS.Dict<string | string[]>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(name, item);
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

export function exactOriginGuard(env: Env): RequestHandler {
  const allowed = new Set(env.browserOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      if (!origin || !allowed.has(origin))
        return next(new AppError(403, 'origin_forbidden', 'Asal permintaan tidak diizinkan.'));
      res.status(204).end();
      return;
    }
    if (UNSAFE_METHODS.has(req.method) && (!origin || !allowed.has(origin))) {
      return next(new AppError(403, 'origin_forbidden', 'Asal permintaan tidak diizinkan.'));
    }
    next();
  };
}

export function csrfToken(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`jalin-csrf\0${sessionId}`).digest('base64url');
}

function validCsrf(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function profileImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const normalized = parsed.toString();
  return normalized.length > 2048 ? null : normalized;
}

export function authenticate(
  auth: Auth,
  prisma: PrismaClient,
  validateSession: (sessionId: string, userId: string, institutionId: string) => Promise<boolean>,
): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const session = await auth.api.getSession({ headers: requestHeaders(req.headers) });
    if (!session?.user.institutionId)
      throw new AppError(401, 'unauthorized', 'Silakan masuk untuk melanjutkan.');
    const institution = await prisma.institution.findFirst({
      where: { id: session.user.institutionId, status: 'ACTIVE', user: { id: session.user.id } },
      select: { id: true, name: true },
    });
    if (!institution) throw new AppError(401, 'unauthorized', 'Sesi tidak lagi berlaku.');
    if (!(await validateSession(session.session.id, session.user.id, session.user.institutionId)))
      throw new AppError(401, 'unauthorized', 'Sesi tidak lagi berlaku.');
    req.authContext = {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: profileImageUrl(session.user.image),
      institutionId: institution.id,
      institutionName: institution.name,
      sessionId: session.session.id,
      sessionExpiresAt: session.session.expiresAt,
    };
    next();
  });
}

export function requireCsrf(secret: string): RequestHandler {
  return (req, _res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    const context = req.authContext;
    if (!context || !validCsrf(req.get('x-csrf-token'), csrfToken(context.sessionId, secret))) {
      return next(
        new AppError(
          403,
          'csrf_invalid',
          'Permintaan keamanan tidak valid. Muat ulang halaman dan coba lagi.',
        ),
      );
    }
    next();
  };
}

export function protectAuthMutation(
  auth: Auth,
  secret: string,
  prepareRevocation: (sessionId: string) => Promise<void>,
): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    if (req.method !== 'POST' || !req.path.endsWith('/sign-out')) return next();
    const session = await auth.api.getSession({ headers: requestHeaders(req.headers) });
    if (!session || !validCsrf(req.get('x-csrf-token'), csrfToken(session.session.id, secret))) {
      throw new AppError(
        403,
        'csrf_invalid',
        'Permintaan keamanan tidak valid. Muat ulang halaman dan coba lagi.',
      );
    }
    await prepareRevocation(session.session.id);
    next();
  });
}
