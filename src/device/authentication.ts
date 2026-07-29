import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import type { DeviceHello, DeviceProve } from './protocol.js';

const CHALLENGE_TTL_SECONDS = 15;
const CHALLENGE_PREFIX = 'jalin:device:challenge:';

export interface DeviceChallengeRecord {
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
}

export function encryptDeviceCredential(secret: Buffer, keyVersion: number, env: Env): Buffer {
  const key = env.DEVICE_CREDENTIAL_KEYS.get(keyVersion);
  if (!key) throw new Error('Versi kunci kredensial perangkat tidak tersedia');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptDeviceCredential(
  ciphertext: Uint8Array,
  keyVersion: number,
  env: Env,
): Buffer {
  const key = env.DEVICE_CREDENTIAL_KEYS.get(keyVersion);
  const value = Buffer.from(ciphertext);
  if (!key || value.length < 29) throw new Error('Kredensial perangkat tidak valid');
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
  } catch {
    throw new Error('Kredensial perangkat tidak valid');
  }
}

export async function issueDeviceChallenge(
  redis: Redis,
  hello: DeviceHello,
  nowMs = Date.now(),
): Promise<DeviceChallengeRecord> {
  const record = {
    challengeId: randomUUID(),
    nonce: randomBytes(32).toString('base64url'),
    expiresAtMs: nowMs + CHALLENGE_TTL_SECONDS * 1_000,
  };
  const stored = JSON.stringify({
    deviceId: hello.deviceId,
    institutionId: hello.institutionId,
    bootId: hello.bootId,
    nonce: record.nonce,
    expiresAtMs: record.expiresAtMs,
  });
  const accepted = await redis.set(
    `${CHALLENGE_PREFIX}${record.challengeId}`,
    stored,
    'EX',
    CHALLENGE_TTL_SECONDS,
    'NX',
  );
  if (accepted !== 'OK') throw new Error('Gagal membuat tantangan perangkat');
  return record;
}

export async function verifyDeviceProof(
  redis: Redis,
  prove: DeviceProve,
  hello: DeviceHello,
  secret: Buffer,
  nowMs = Date.now(),
): Promise<boolean> {
  const key = `${CHALLENGE_PREFIX}${prove.payload.challengeId}`;
  const encoded = await redis.call('GETDEL', key);
  if (typeof encoded !== 'string') return false;
  let record: {
    deviceId: string;
    institutionId: string;
    bootId: string;
    nonce: string;
    expiresAtMs: number;
  };
  try {
    record = JSON.parse(encoded) as typeof record;
  } catch {
    return false;
  }
  if (
    record.expiresAtMs < nowMs ||
    record.deviceId !== hello.deviceId ||
    record.institutionId !== hello.institutionId ||
    record.bootId !== hello.bootId
  )
    return false;
  const material = `jalin-device-v1\n${prove.payload.challengeId}\n${record.nonce}\n${hello.deviceId}\n${hello.institutionId}\n${hello.bootId}`;
  const expected = createHmac('sha256', secret).update(material).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(prove.payload.proof, 'base64url');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
