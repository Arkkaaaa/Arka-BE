import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { DeviceServerMessage } from './protocol.js';

const PREFIX = 'arka:{mode3}';
const LOCK_KEY = `${PREFIX}:lock`;
const COMMAND_QUEUE_KEY = `${PREFIX}:commands`;
const COMMAND_SEQUENCE_KEY = `${PREFIX}:command-sequence`;
const LOCK_TTL_SECONDS = 30;
const STATE_TTL_SECONDS = 3_600;

const LockSchema = z
  .object({
    lockId: z.string().uuid(),
    institutionId: z.string().uuid(),
    ownerSessionId: z.string().min(1).max(191),
    holderType: z.enum(['PREPARATION', 'SESSION']),
    preparationId: z.string().min(20).max(128),
    setupId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    state: z.enum(['HELD', 'RELEASING']),
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

const AssociationSchema = z
  .object({
    lockId: z.string().uuid(),
    associationId: z.string().uuid(),
    type: z.enum(['SETUP', 'SESSION']),
    state: z.enum(['BINDING', 'BOUND', 'UNBINDING']),
  })
  .strict();

const CommandSchema = z
  .object({
    commandId: z.string().uuid(),
    lockId: z.string().uuid(),
    associationId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    kind: z.enum(['SETUP_BIND', 'SETUP_UNBIND', 'SESSION_BIND', 'SESSION_UNBIND', 'FEEDBACK']),
    sequence: z.number().int().positive(),
    payload: z.unknown(),
    expiresAtMs: z.number().int().positive(),
    status: z.enum(['PENDING', 'SENT', 'ACKED', 'NACKED']),
    connectionId: z.string().uuid().nullable(),
    bootId: z.string().uuid().nullable(),
    nackReason: z.string().max(80).nullable(),
  })
  .strict();

export type Mode3Lock = z.infer<typeof LockSchema>;
export type Mode3Association = z.infer<typeof AssociationSchema>;
export type Mode3Command = z.infer<typeof CommandSchema>;
export type Mode3CommandKind = Mode3Command['kind'];

const REFRESH_LOCK_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local lock = cjson.decode(encoded)
if lock.lockId ~= ARGV[1] then return 0 end
lock.expiresAtMs = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(lock), 'EX', ARGV[3])
return 1
`;

const TRANSITION_LOCK_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local lock = cjson.decode(encoded)
if lock.lockId ~= ARGV[1] or lock.ownerSessionId ~= ARGV[2] or lock.holderType ~= ARGV[3] then return 0 end
if ARGV[3] == 'PREPARATION' and lock.preparationId ~= ARGV[4] then return 0 end
if ARGV[3] == 'SESSION' and lock.sessionId ~= ARGV[4] then return 0 end
redis.call('SET', KEYS[1], ARGV[5], 'EX', ARGV[6])
return 1
`;

const RELEASE_LOCK_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 1 end
local lock = cjson.decode(encoded)
if lock.lockId ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

const ENQUEUE_COMMAND_SCRIPT = `
local sequence = redis.call('INCR', KEYS[1])
local command = cjson.decode(ARGV[1])
command.sequence = sequence
local encoded = cjson.encode(command)
redis.call('SET', KEYS[2], encoded, 'EX', ARGV[2])
redis.call('ZADD', KEYS[3], sequence, command.commandId)
redis.call('EXPIRE', KEYS[3], ARGV[2])
return encoded
`;

function associationKey(type: Mode3Association['type'], associationId: string): string {
  return `${PREFIX}:association:${type.toLowerCase()}:${associationId}`;
}

function commandKey(commandId: string): string {
  return `${PREFIX}:command:${commandId}`;
}

function decode<T>(encoded: string | null, schema: z.ZodType<T>): T | null {
  if (!encoded) return null;
  try {
    return schema.parse(JSON.parse(encoded));
  } catch {
    return null;
  }
}

export async function readMode3Lock(redis: Redis): Promise<Mode3Lock | null> {
  return decode(await redis.get(LOCK_KEY), LockSchema);
}

export async function acquireMode3Lock(
  redis: Redis,
  input: Omit<Mode3Lock, 'lockId' | 'state' | 'expiresAtMs' | 'sessionId'>,
): Promise<Mode3Lock | null> {
  const lock = LockSchema.parse({
    ...input,
    lockId: randomUUID(),
    sessionId: null,
    state: 'HELD',
    expiresAtMs: Date.now() + LOCK_TTL_SECONDS * 1_000,
  });
  const acquired = await redis.set(LOCK_KEY, JSON.stringify(lock), 'EX', LOCK_TTL_SECONDS, 'NX');
  return acquired === 'OK' ? lock : null;
}

export async function refreshMode3Lock(redis: Redis, lockId: string): Promise<boolean> {
  const refreshed = await redis.eval(
    REFRESH_LOCK_SCRIPT,
    1,
    LOCK_KEY,
    lockId,
    String(Date.now() + LOCK_TTL_SECONDS * 1_000),
    String(LOCK_TTL_SECONDS),
  );
  return Number(refreshed) === 1;
}

export async function transitionMode3Lock(
  redis: Redis,
  current: Mode3Lock,
  next: Pick<Mode3Lock, 'holderType' | 'sessionId' | 'state'>,
): Promise<Mode3Lock | null> {
  const transitioned = LockSchema.parse({
    ...current,
    ...next,
    expiresAtMs: Date.now() + LOCK_TTL_SECONDS * 1_000,
  });
  const currentHolderId =
    current.holderType === 'PREPARATION' ? current.preparationId : current.sessionId;
  if (!currentHolderId) return null;
  const changed = await redis.eval(
    TRANSITION_LOCK_SCRIPT,
    1,
    LOCK_KEY,
    current.lockId,
    current.ownerSessionId,
    current.holderType,
    currentHolderId,
    JSON.stringify(transitioned),
    String(LOCK_TTL_SECONDS),
  );
  return Number(changed) === 1 ? transitioned : null;
}

export async function releaseMode3Lock(redis: Redis, lockId: string): Promise<boolean> {
  const released = await redis.eval(RELEASE_LOCK_SCRIPT, 1, LOCK_KEY, lockId);
  return Number(released) === 1;
}

export async function writeMode3Association(
  redis: Redis,
  association: Mode3Association,
): Promise<void> {
  const parsed = AssociationSchema.parse(association);
  await redis.set(
    associationKey(parsed.type, parsed.associationId),
    JSON.stringify(parsed),
    'EX',
    STATE_TTL_SECONDS,
  );
}

export async function readMode3Association(
  redis: Redis,
  type: Mode3Association['type'],
  associationId: string,
): Promise<Mode3Association | null> {
  return decode(await redis.get(associationKey(type, associationId)), AssociationSchema);
}

export async function updateMode3AssociationState(
  redis: Redis,
  type: Mode3Association['type'],
  associationId: string,
  lockId: string,
  state: Mode3Association['state'],
): Promise<boolean> {
  const association = await readMode3Association(redis, type, associationId);
  if (!association || association.lockId !== lockId) return false;
  await writeMode3Association(redis, { ...association, state });
  return true;
}

export async function deleteMode3Association(
  redis: Redis,
  type: Mode3Association['type'],
  associationId: string,
): Promise<void> {
  await redis.del(associationKey(type, associationId));
}

export interface EnqueueMode3CommandInput {
  readonly lockId: string;
  readonly associationId: string;
  readonly sessionId?: string;
  readonly kind: Mode3CommandKind;
  readonly payload: unknown;
  readonly expiresAt: Date;
}

export async function enqueueMode3Command(
  redis: Redis,
  input: EnqueueMode3CommandInput,
): Promise<Mode3Command> {
  const command = CommandSchema.omit({ sequence: true }).parse({
    commandId: randomUUID(),
    lockId: input.lockId,
    associationId: input.associationId,
    sessionId: input.sessionId ?? null,
    kind: input.kind,
    payload: input.payload,
    expiresAtMs: input.expiresAt.getTime(),
    status: 'PENDING',
    connectionId: null,
    bootId: null,
    nackReason: null,
  });
  const ttlSeconds = Math.max(1, Math.ceil((input.expiresAt.getTime() - Date.now()) / 1_000));
  const encoded = await redis.eval(
    ENQUEUE_COMMAND_SCRIPT,
    3,
    COMMAND_SEQUENCE_KEY,
    commandKey(command.commandId),
    COMMAND_QUEUE_KEY,
    JSON.stringify(command),
    String(Math.max(ttlSeconds, 60)),
  );
  if (typeof encoded !== 'string') throw new Error('Perintah Mode 3 gagal disimpan');
  return CommandSchema.parse(JSON.parse(encoded));
}

export async function listMode3Commands(redis: Redis, nowMs = Date.now()): Promise<Mode3Command[]> {
  const ids = await redis.zrange(COMMAND_QUEUE_KEY, 0, 31);
  if (ids.length === 0) return [];
  const encoded = await redis.mget(ids.map(commandKey));
  const commands: Mode3Command[] = [];
  const expired: string[] = [];
  for (const [index, value] of encoded.entries()) {
    const command = decode(value, CommandSchema);
    if (!command || command.expiresAtMs <= nowMs || ['ACKED', 'NACKED'].includes(command.status)) {
      expired.push(ids[index]!);
    } else {
      commands.push(command);
    }
  }
  if (expired.length > 0) await redis.zrem(COMMAND_QUEUE_KEY, ...expired);
  return commands;
}

export async function markMode3CommandDispatched(
  redis: Redis,
  command: Mode3Command,
  connectionId: string,
  bootId: string,
): Promise<Mode3Command | null> {
  const current = decode(await redis.get(commandKey(command.commandId)), CommandSchema);
  if (!current || current.expiresAtMs <= Date.now() || !['PENDING', 'SENT'].includes(current.status))
    return null;
  const updated = CommandSchema.parse({
    ...current,
    status: 'SENT',
    connectionId,
    bootId,
  });
  await redis.set(commandKey(updated.commandId), JSON.stringify(updated), 'EX', STATE_TTL_SECONDS);
  return updated;
}

export async function acknowledgeMode3Command(
  redis: Redis,
  input: {
    readonly commandId: string;
    readonly associationId: string;
    readonly connectionId: string;
    readonly bootId: string;
    readonly outcome: 'ACK' | 'NACK';
    readonly reason?: string;
  },
): Promise<{ command: Mode3Command; duplicate: boolean } | null> {
  const command = decode(await redis.get(commandKey(input.commandId)), CommandSchema);
  if (
    !command ||
    command.associationId !== input.associationId ||
    command.connectionId !== input.connectionId ||
    command.bootId !== input.bootId ||
    command.expiresAtMs <= Date.now()
  )
    return null;
  const status = input.outcome === 'ACK' ? 'ACKED' : 'NACKED';
  if (command.status === status && command.nackReason === (input.reason ?? null))
    return { command, duplicate: true };
  if (command.status !== 'SENT') return null;
  const updated = CommandSchema.parse({
    ...command,
    status,
    nackReason: input.outcome === 'NACK' ? (input.reason ?? null) : null,
  });
  await redis
    .multi()
    .set(commandKey(updated.commandId), JSON.stringify(updated), 'EX', STATE_TTL_SECONDS)
    .zrem(COMMAND_QUEUE_KEY, updated.commandId)
    .exec();
  return { command: updated, duplicate: false };
}

export function commandToWire(command: Mode3Command, sentAtMs = Date.now()): DeviceServerMessage {
  const base = {
    protocolVersion: 1 as const,
    messageId: randomUUID(),
    sentAtMs,
    sequence: command.sequence,
  };
  if (command.kind === 'SETUP_BIND' || command.kind === 'SETUP_UNBIND') {
    return {
      ...base,
      type: command.kind === 'SETUP_BIND' ? 'setup.bind' : 'setup.unbind',
      payload: {
        commandId: command.commandId,
        reservationId: command.lockId,
        setupId: command.associationId,
      },
    };
  }
  if (command.kind === 'SESSION_BIND' || command.kind === 'SESSION_UNBIND') {
    return {
      ...base,
      type: command.kind === 'SESSION_BIND' ? 'session.bind' : 'session.unbind',
      payload: {
        commandId: command.commandId,
        reservationId: command.lockId,
        sessionId: command.associationId,
      },
    };
  }
  const parsed = z
    .object({
      action: z.enum([
        'LED_SUCCESS',
        'HAPTIC_SUCCESS',
        'LED_CORRECT',
        'LED_INCORRECT',
        'HAPTIC_PULSE',
        'HARD_STOP',
      ]),
      expiresAfterMs: z.number().int().min(1).max(1_000),
    })
    .strict()
    .parse(command.payload);
  return {
    ...base,
    type: 'device.feedback',
    payload: {
      commandId: command.commandId,
      sessionId: command.associationId,
      ...parsed,
    },
  };
}

export async function clearMode3Ownership(redis: Redis, lockId?: string): Promise<boolean> {
  const lock = await readMode3Lock(redis);
  if (lockId && lock && lock.lockId !== lockId) return false;
  const commandIds = await redis.zrange(COMMAND_QUEUE_KEY, 0, -1);
  const keys = [
    COMMAND_QUEUE_KEY,
    ...(lock
      ? [
          associationKey('SETUP', lock.setupId),
          ...(lock.sessionId ? [associationKey('SESSION', lock.sessionId)] : []),
        ]
      : []),
    ...commandIds.map(commandKey),
  ];
  if (keys.length > 0) await redis.del(...keys);
  if (lock) return releaseMode3Lock(redis, lock.lockId);
  return true;
}
