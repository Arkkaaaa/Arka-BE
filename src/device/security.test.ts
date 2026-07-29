import { createHmac, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import {
  decryptDeviceCredential,
  encryptDeviceCredential,
  issueDeviceChallenge,
  verifyDeviceProof,
} from './authentication.js';
import {
  DEVICE_MAX_MESSAGE_BYTES,
  DEVICE_PROTOCOL_FIXTURES,
  DeviceHelloSchema,
  DeviceProtocolError,
  DeviceProveSchema,
  parseDeviceMessage,
} from './protocol.js';

function testEnv(): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 4_000,
    DATABASE_URL: 'postgresql://jalin:secret@localhost:5432/jalin',
    REDIS_URL: 'redis://localhost:6379',
    BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters',
    BETTER_AUTH_URL: 'http://localhost:4000',
    LOG_LEVEL: 'silent',
    DEVICE_CREDENTIAL_KEYS: new Map([
      [1, Buffer.alloc(32, 1)],
      [2, Buffer.alloc(32, 2)],
    ]),
    DEVICE_ACTIVE_KEY_VERSION: 2,
    PREPARATION_TTL_MS: 300_000,
    BINDING_DEADLINE_MS: 20_000,
    IDEMPOTENCY_TTL_MS: 86_400_000,
    DEVICE_COMMAND_TTL_MS: 30_000,
    OLLAMA_BASE_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'qwen2.5:3b',
    OLLAMA_TIMEOUT_MS: 8_000,
    OLLAMA_WORKER_INTERVAL_MS: 5_000,
    OLLAMA_LEASE_MS: 30_000,
    OLLAMA_MAX_ATTEMPTS: 3,
    OPERATIONS_ALERT_WEBHOOK_URL: 'https://alerts.example.test/jalin',
    OPERATIONS_ALERT_WEBHOOK_TOKEN: 'test-alert-token-with-32-characters',
    OUTBOX_REQUEST_TIMEOUT_MS: 8_000,
    OUTBOX_WORKER_INTERVAL_MS: 5_000,
    OUTBOX_LEASE_MS: 30_000,
    OUTBOX_MAX_ATTEMPTS: 10,
    browserOrigins: ['http://localhost:4000', 'http://localhost:5173'],
    googleOAuth: null,
    ollamaModelAllowlist: new Set(['qwen2.5:3b']),
  };
}

function fakeChallengeRedis(): Redis {
  const values = new Map<string, string>();
  return {
    set: (key: string, value: string) => {
      if (values.has(key)) return Promise.resolve(null);
      values.set(key, value);
      return Promise.resolve('OK');
    },
    call: (command: string, key: string) => {
      if (command !== 'GETDEL') return Promise.resolve(null);
      const value = values.get(key) ?? null;
      values.delete(key);
      return Promise.resolve(value);
    },
  } as unknown as Redis;
}

describe('device credential protection', () => {
  it('decrypts only with the recorded key version and rejects tampering', () => {
    const env = testEnv();
    const secret = randomBytes(32);
    const encrypted = encryptDeviceCredential(secret, 2, env);

    expect(decryptDeviceCredential(encrypted, 2, env)).toEqual(secret);
    expect(() => decryptDeviceCredential(encrypted, 1, env)).toThrow(
      'Kredensial perangkat tidak valid',
    );

    const tampered = Buffer.from(encrypted);
    const finalByte = tampered.at(-1);
    if (finalByte === undefined) throw new Error('Encrypted credential unexpectedly empty');
    tampered[tampered.length - 1] = finalByte ^ 1;
    expect(() => decryptDeviceCredential(tampered, 2, env)).toThrow(
      'Kredensial perangkat tidak valid',
    );
  });
});

describe('device challenge authentication', () => {
  it('accepts a correct proof exactly once', async () => {
    const redis = fakeChallengeRedis();
    const hello = DeviceHelloSchema.parse(DEVICE_PROTOCOL_FIXTURES.hello);
    const secret = randomBytes(32);
    const challenge = await issueDeviceChallenge(redis, hello, 1_000);
    const material = [
      'jalin-device-v1',
      challenge.challengeId,
      challenge.nonce,
      hello.deviceId,
      hello.institutionId,
      hello.bootId,
    ].join('\n');
    const prove = DeviceProveSchema.parse({
      protocolVersion: 1,
      type: 'device.prove',
      messageId: '018f2f6e-7b23-7f6b-9238-0242ac120010',
      sentAtMs: 1_100,
      sequence: 0,
      deviceId: hello.deviceId,
      payload: {
        challengeId: challenge.challengeId,
        proof: createHmac('sha256', secret).update(material).digest('base64url'),
      },
    });

    await expect(verifyDeviceProof(redis, prove, hello, secret, 1_100)).resolves.toBe(true);
    await expect(verifyDeviceProof(redis, prove, hello, secret, 1_100)).resolves.toBe(false);
  });

  it('consumes an expired challenge before rejecting it', async () => {
    const redis = fakeChallengeRedis();
    const hello = DeviceHelloSchema.parse(DEVICE_PROTOCOL_FIXTURES.hello);
    const secret = randomBytes(32);
    const challenge = await issueDeviceChallenge(redis, hello, 1_000);
    const prove = DeviceProveSchema.parse({
      protocolVersion: 1,
      type: 'device.prove',
      messageId: '018f2f6e-7b23-7f6b-9238-0242ac120011',
      sentAtMs: challenge.expiresAtMs + 1,
      sequence: 0,
      deviceId: hello.deviceId,
      payload: {
        challengeId: challenge.challengeId,
        proof: Buffer.alloc(32).toString('base64url'),
      },
    });

    await expect(
      verifyDeviceProof(redis, prove, hello, secret, challenge.expiresAtMs + 1),
    ).resolves.toBe(false);
    await expect(verifyDeviceProof(redis, prove, hello, secret, 1_100)).resolves.toBe(false);
  });
});

describe('device protocol parser', () => {
  it('accepts a canonical fixture and rejects unknown fields', () => {
    expect(parseDeviceMessage(JSON.stringify(DEVICE_PROTOCOL_FIXTURES.hello))).toMatchObject({
      type: 'device.hello',
      deviceId: 'jalin-demo-001',
    });
    expect(() =>
      parseDeviceMessage(JSON.stringify({ ...DEVICE_PROTOCOL_FIXTURES.hello, credential: 'leak' })),
    ).toThrowError(new DeviceProtocolError('INVALID_MESSAGE'));
  });

  it('rejects malformed and oversized frames before schema processing', () => {
    expect(() => parseDeviceMessage('{')).toThrowError(new DeviceProtocolError('MALFORMED_JSON'));
    expect(() => parseDeviceMessage('x'.repeat(DEVICE_MAX_MESSAGE_BYTES + 1))).toThrowError(
      new DeviceProtocolError('MESSAGE_TOO_LARGE'),
    );
  });
});
