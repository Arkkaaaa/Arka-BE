import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { DEVICE_SUBPROTOCOL, type DeviceHello, type DeviceProve } from './protocol.js';

const CHALLENGE_TTL_SECONDS = 15;
const CHALLENGE_PREFIX = 'arka:{mode3}:challenge:';

export interface DeviceChallengeRecord {
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
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
  let record: { bootId: string; nonce: string; expiresAtMs: number };
  try {
    record = JSON.parse(encoded) as typeof record;
  } catch {
    return false;
  }
  if (record.expiresAtMs < nowMs || record.bootId !== hello.bootId) return false;
  const material = `${DEVICE_SUBPROTOCOL}\n${prove.payload.challengeId}\n${record.nonce}\n${hello.bootId}`;
  const expected = createHmac('sha256', secret).update(material).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(prove.payload.proof, 'base64url');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
