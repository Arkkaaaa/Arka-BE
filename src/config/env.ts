import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const MAX_TIMER_MS = 2_147_483_647;
const originSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      ctx.addIssue({
        code: 'custom',
        message: 'Origin must not include path, query, credentials, or fragment',
      });
      return z.NEVER;
    }
    return url.origin;
  });

const credentialKeyringSchema = z.string().transform((raw, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'DEVICE_CREDENTIAL_KEYS must be valid JSON' });
    return z.NEVER;
  }
  const record = z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)).safeParse(parsed);
  if (!record.success) {
    ctx.addIssue({
      code: 'custom',
      message: 'DEVICE_CREDENTIAL_KEYS must map positive integer versions to base64 keys',
    });
    return z.NEVER;
  }
  const keys = new Map<number, Buffer>();
  for (const [version, encoded] of Object.entries(record.data)) {
    const key = Buffer.from(encoded, 'base64');
    if (
      key.length !== 32 ||
      key.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Credential key version ${version} must be canonical base64 for exactly 32 bytes`,
      });
      return z.NEVER;
    }
    keys.set(Number(version), key);
  }
  return keys;
});

const privateOllamaUrlSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'OLLAMA_BASE_URL must be an HTTP(S) server URL without credentials, query, or fragment',
      });
      return z.NEVER;
    }
    const hostname = url.hostname.toLowerCase();
    const privateHost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      /^10\./u.test(hostname) ||
      /^192\.168\./u.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./u.test(hostname);
    if (!privateHost) {
      ctx.addIssue({
        code: 'custom',
        message: 'OLLAMA_BASE_URL must resolve through an explicitly private hostname or address',
      });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });

const alertWebhookUrlSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'OPERATIONS_ALERT_WEBHOOK_URL must be an HTTP(S) URL without credentials, query, or fragment',
      });
      return z.NEVER;
    }
    return url.toString();
  });

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//u.test(value), 'DATABASE_URL must be PostgreSQL'),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => /^rediss?:\/\//u.test(value), 'REDIS_URL must use redis:// or rediss://'),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  BROWSER_ORIGINS: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DEVICE_CREDENTIAL_KEYS: credentialKeyringSchema,
  DEVICE_ACTIVE_KEY_VERSION: positiveInt,
  PREPARATION_TTL_MS: positiveInt.default(300_000),
  BINDING_DEADLINE_MS: positiveInt.default(20_000),
  IDEMPOTENCY_TTL_MS: positiveInt.default(86_400_000),
  DEVICE_COMMAND_TTL_MS: positiveInt.default(30_000),
  OLLAMA_BASE_URL: privateOllamaUrlSchema,
  OLLAMA_MODEL: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_.:/-]+$/u),
  OLLAMA_MODEL_ALLOWLIST: z.string().min(1),
  OLLAMA_TIMEOUT_MS: positiveInt.max(MAX_TIMER_MS).default(8_000),
  OLLAMA_WORKER_INTERVAL_MS: positiveInt.max(MAX_TIMER_MS).default(5_000),
  OLLAMA_LEASE_MS: positiveInt.max(MAX_TIMER_MS).default(30_000),
  OLLAMA_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  OPERATIONS_ALERT_WEBHOOK_URL: alertWebhookUrlSchema,
  OPERATIONS_ALERT_WEBHOOK_TOKEN: z.string().min(32),
  OUTBOX_REQUEST_TIMEOUT_MS: positiveInt.max(MAX_TIMER_MS).default(8_000),
  OUTBOX_WORKER_INTERVAL_MS: positiveInt.max(MAX_TIMER_MS).default(5_000),
  OUTBOX_LEASE_MS: positiveInt.max(MAX_TIMER_MS).default(30_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(10),
});

export type Env = Omit<
  z.infer<typeof rawEnvSchema>,
  'BROWSER_ORIGINS' | 'OLLAMA_MODEL_ALLOWLIST' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'
> & {
  readonly browserOrigins: readonly string[];
  readonly googleOAuth: Readonly<{ clientId: string; clientSecret: string }> | null;
  readonly ollamaModelAllowlist: ReadonlySet<string>;
};

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = rawEnvSchema.parse(source);
  const browserOrigins = z
    .array(originSchema)
    .min(1)
    .parse(
      parsed.BROWSER_ORIGINS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
  const ollamaModelAllowlist = new Set(
    parsed.OLLAMA_MODEL_ALLOWLIST.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!ollamaModelAllowlist.has(parsed.OLLAMA_MODEL)) {
    throw new Error('OLLAMA_MODEL must be present in OLLAMA_MODEL_ALLOWLIST');
  }
  if (!parsed.DEVICE_CREDENTIAL_KEYS.has(parsed.DEVICE_ACTIVE_KEY_VERSION)) {
    throw new Error('DEVICE_ACTIVE_KEY_VERSION is missing from DEVICE_CREDENTIAL_KEYS');
  }
  const authOrigin = new URL(parsed.BETTER_AUTH_URL).origin;
  if (parsed.NODE_ENV === 'production' && new URL(parsed.BETTER_AUTH_URL).protocol !== 'https:') {
    throw new Error('BETTER_AUTH_URL must use HTTPS in production');
  }
  if (!browserOrigins.includes(authOrigin)) {
    throw new Error('BETTER_AUTH_URL origin must be included in BROWSER_ORIGINS');
  }
  const hasGoogleClientId = parsed.GOOGLE_CLIENT_ID !== undefined;
  const hasGoogleClientSecret = parsed.GOOGLE_CLIENT_SECRET !== undefined;
  if (hasGoogleClientId !== hasGoogleClientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
  }
  const googleOAuth =
    parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET
      ? Object.freeze({
          clientId: parsed.GOOGLE_CLIENT_ID,
          clientSecret: parsed.GOOGLE_CLIENT_SECRET,
        })
      : null;
  if (
    parsed.NODE_ENV === 'production' &&
    new URL(parsed.OPERATIONS_ALERT_WEBHOOK_URL).protocol !== 'https:'
  ) {
    throw new Error('OPERATIONS_ALERT_WEBHOOK_URL must use HTTPS in production');
  }
  if (parsed.OUTBOX_LEASE_MS <= parsed.OUTBOX_REQUEST_TIMEOUT_MS) {
    throw new Error('OUTBOX_LEASE_MS must exceed OUTBOX_REQUEST_TIMEOUT_MS');
  }
  const rest = { ...parsed };
  Reflect.deleteProperty(rest, 'BROWSER_ORIGINS');
  Reflect.deleteProperty(rest, 'OLLAMA_MODEL_ALLOWLIST');
  Reflect.deleteProperty(rest, 'GOOGLE_CLIENT_ID');
  Reflect.deleteProperty(rest, 'GOOGLE_CLIENT_SECRET');
  return Object.freeze({
    ...rest,
    browserOrigins: Object.freeze(browserOrigins),
    googleOAuth,
    ollamaModelAllowlist,
  });
}

export const env = parseEnv(process.env);
