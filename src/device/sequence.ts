import type { Redis } from 'ioredis';
import type { AuthenticatedDeviceMessage } from './protocol.js';
import { DEVICE_MAX_MESSAGES_PER_SECOND, DEVICE_MAX_SEQUENCE_GAP } from './protocol.js';

export type DeviceSequenceDecision = 'ACCEPT' | 'DUPLICATE' | 'STALE' | 'GAP' | 'RATE_LIMITED';

const ENFORCE_SEQUENCE_SCRIPT = `
local sequenceKey = KEYS[1]
local messageKey = KEYS[2]
local rateKey = KEYS[3]
local fsrRateKey = KEYS[4]
local proposed = tonumber(ARGV[1])
local maxGap = tonumber(ARGV[2])
local maxRate = tonumber(ARGV[3])
local fsr = ARGV[4] == '1'
local current = tonumber(redis.call('GET', sequenceKey) or '0')
if redis.call('EXISTS', messageKey) == 1 then return 'DUPLICATE' end
if proposed <= current then return 'STALE' end
if proposed - current > maxGap then return 'GAP' end
local rate = redis.call('INCR', rateKey)
if rate == 1 then redis.call('EXPIRE', rateKey, 2) end
if rate > maxRate then return 'RATE_LIMITED' end
if fsr then
  local fsrRate = redis.call('INCR', fsrRateKey)
  if fsrRate == 1 then redis.call('EXPIRE', fsrRateKey, 2) end
  if fsrRate > 10 then return 'RATE_LIMITED' end
end
redis.call('SET', sequenceKey, proposed, 'EX', 86400)
redis.call('SET', messageKey, '1', 'EX', 300)
return 'ACCEPT'
`;

export async function enforceDeviceSequence(
  redis: Redis,
  deviceKey: string,
  bootId: string,
  message: AuthenticatedDeviceMessage,
  receivedAtMs = Date.now(),
): Promise<DeviceSequenceDecision> {
  const prefix = `arka:device:boot:${deviceKey}:${bootId}`;
  const second = Math.floor(receivedAtMs / 1_000);
  const result = await redis.eval(
    ENFORCE_SEQUENCE_SCRIPT,
    4,
    `${prefix}:sequence`,
    `${prefix}:message:${message.messageId}`,
    `${prefix}:rate:${second}`,
    `${prefix}:fsr:${second}`,
    String(message.sequence),
    String(DEVICE_MAX_SEQUENCE_GAP),
    String(DEVICE_MAX_MESSAGES_PER_SECOND),
    message.type === 'telemetry.fsr' ? '1' : '0',
  );
  if (
    result === 'ACCEPT' ||
    result === 'DUPLICATE' ||
    result === 'STALE' ||
    result === 'GAP' ||
    result === 'RATE_LIMITED'
  )
    return result;
  throw new Error('Hasil pemeriksaan urutan perangkat tidak dikenal');
}
