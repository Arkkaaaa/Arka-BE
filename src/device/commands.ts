import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { DeviceServerMessage } from './protocol.js';

export type CommandDb = Prisma.TransactionClient;
export type DurableCommandKind =
  'SETUP_BIND' | 'SETUP_UNBIND' | 'SESSION_BIND' | 'SESSION_UNBIND' | 'FEEDBACK';

export interface EnqueueDeviceCommandInput {
  readonly deviceId: string;
  readonly reservationId?: string;
  readonly sessionId?: string;
  readonly associationId: string;
  readonly kind: DurableCommandKind;
  readonly payload: Prisma.InputJsonValue;
  readonly expiresAt: Date;
}

export async function enqueueDeviceCommand(db: CommandDb, input: EnqueueDeviceCommandInput) {
  await db.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', input.deviceId);
  const latest = await db.deviceCommand.findFirst({
    where: { deviceId: input.deviceId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  return db.deviceCommand.create({
    data: {
      commandId: randomUUID(),
      deviceId: input.deviceId,
      ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      associationId: input.associationId,
      kind: input.kind,
      sequence: (latest?.sequence ?? 0n) + 1n,
      payload: input.payload,
      expiresAt: input.expiresAt,
    },
  });
}

export function commandToWire(
  command: {
    commandId: string;
    reservationId: string | null;
    associationId: string | null;
    sessionId: string | null;
    kind: DurableCommandKind;
    sequence: bigint;
    payload: unknown;
    expiresAt: Date;
  },
  sentAtMs = Date.now(),
): DeviceServerMessage {
  if (!command.associationId) throw new Error('Command association is missing');
  const base = {
    protocolVersion: 1 as const,
    messageId: randomUUID(),
    sentAtMs,
    sequence: Number(command.sequence),
  };
  if (command.kind === 'SETUP_BIND' || command.kind === 'SETUP_UNBIND') {
    if (!command.reservationId) throw new Error('Setup command reservation is missing');
    return {
      ...base,
      type: command.kind === 'SETUP_BIND' ? 'setup.bind' : 'setup.unbind',
      payload: {
        commandId: command.commandId,
        reservationId: command.reservationId,
        setupId: command.associationId,
      },
    };
  }
  if (command.kind === 'SESSION_BIND' || command.kind === 'SESSION_UNBIND') {
    if (!command.reservationId) throw new Error('Session command reservation is missing');
    return {
      ...base,
      type: command.kind === 'SESSION_BIND' ? 'session.bind' : 'session.unbind',
      payload: {
        commandId: command.commandId,
        reservationId: command.reservationId,
        sessionId: command.associationId,
      },
    };
  }
  const parsed = command.payload as { action?: unknown; expiresAfterMs?: unknown };
  if (typeof parsed.action !== 'string' || typeof parsed.expiresAfterMs !== 'number')
    throw new Error('Feedback payload is invalid');
  return {
    ...base,
    type: 'device.feedback',
    payload: {
      commandId: command.commandId,
      sessionId: command.associationId,
      action: parsed.action as
        | 'LED_SUCCESS'
        | 'HAPTIC_SUCCESS'
        | 'LED_CORRECT'
        | 'LED_INCORRECT'
        | 'HAPTIC_PULSE'
        | 'HARD_STOP',
      expiresAfterMs: parsed.expiresAfterMs,
    },
  };
}

export async function markCommandDispatched(
  prisma: PrismaClient,
  commandId: string,
  connectionId: string,
  bootId: string,
  sentAt = new Date(),
) {
  return prisma.deviceCommand.updateMany({
    where: { commandId, status: { in: ['PENDING', 'SENT'] }, expiresAt: { gt: sentAt } },
    data: { status: 'SENT', connectionId, bootId, sentAt },
  });
}

export async function expireCommands(prisma: PrismaClient, now = new Date()): Promise<number> {
  const result = await prisma.deviceCommand.updateMany({
    where: { status: { in: ['PENDING', 'SENT'] }, expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
