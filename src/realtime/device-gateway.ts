import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  decryptDeviceCredential,
  issueDeviceChallenge,
  verifyDeviceProof,
} from '../device/authentication.js';
import {
  commandToWire,
  expireCommands,
  markCommandDispatched,
  type DurableCommandKind,
} from '../device/commands.js';
import {
  DEVICE_MAX_MESSAGE_BYTES,
  DEVICE_STALE_AFTER_MS,
  DeviceAcceptSchema,
  DeviceChallengeSchema,
  DeviceHelloSchema,
  DeviceProveSchema,
  encodeDeviceServerMessage,
  parseDeviceMessage,
  type AuthenticatedDeviceMessage,
  type DeviceClientMessage,
  type DeviceHealthPayload,
  type DeviceHello,
} from '../device/protocol.js';
import {
  isDeviceFirmwareCompatible,
  writeDeviceReadiness,
  type DeviceReadiness,
} from '../device/readiness.js';
import { enforceDeviceSequence } from '../device/sequence.js';
import type { AuthoritativeRuntime } from './runtime.js';
import type { RealtimeDependencies } from './types.js';

const DEVICE_CONNECTION_TTL_SECONDS = 20;
const DEVICE_COMMAND_POLL_MS = 100;
export const DEVICE_READINESS_LOW_BATTERY_PERCENT = 30;
export const DEVICE_INTERRUPT_LOW_BATTERY_PERCENT = 10;
const COMMAND_KINDS: readonly DurableCommandKind[] = [
  'SETUP_BIND',
  'SETUP_UNBIND',
  'SESSION_BIND',
  'SESSION_UNBIND',
  'FEEDBACK',
];
const REFRESH_CONNECTION_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;
const RELEASE_CONNECTION_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

interface AuthenticatedConnection {
  readonly socket: WebSocket;
  readonly hello: DeviceHello;
  readonly connectionId: string;
  readonly firmwareCompatible: boolean;
  lastHealthAtMs: number;
  dispatching: boolean;
  closed: boolean;
  commandTimer: NodeJS.Timeout;
  staleTimer: NodeJS.Timeout;
}

interface DeviceSocketConnection {
  readonly socket: WebSocket;
  readonly cleanup: (reason: string) => Promise<void>;
}

function rejectedReason(result: PromiseRejectedResult): unknown {
  return result.reason as unknown;
}

function connectionKey(deviceId: string): string {
  return `jalin:device:connection:${deviceId}`;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function send(socket: WebSocket, message: Parameters<typeof encodeDeviceServerMessage>[0]): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeDeviceServerMessage(message));
}

function closeProtocol(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(4400, reason.slice(0, 123));
  }
}

function associationFromUnknown(value: unknown): { setupId?: string; sessionId?: string } {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (typeof record['setupId'] === 'string' && uuid.test(record['setupId']))
    return { setupId: record['setupId'] };
  if (typeof record['sessionId'] === 'string' && uuid.test(record['sessionId']))
    return { sessionId: record['sessionId'] };
  return {};
}

function offlineReadiness(): DeviceReadiness {
  return {
    connectionStatus: 'OFFLINE',
    readinessCode: 'OFFLINE',
    firmwareVersion: null,
    capabilities: [],
    batteryPercent: null,
    lastSeenAt: null,
    connectionId: null,
    bootId: null,
  };
}

export interface DeviceHealthDecision {
  readonly readinessCode: DeviceReadiness['readinessCode'];
  readonly interruptionReason: 'DEVICE_FAULT' | 'DEVICE_LOW_BATTERY' | null;
}

export function decideDeviceHealth(
  health: DeviceHealthPayload,
  reservationState: 'HELD' | 'RELEASING' | null,
  firmwareCompatible: boolean,
): DeviceHealthDecision {
  const batteryPercent = health.battery.valid ? (health.battery.percent ?? null) : null;
  const readinessCode = !firmwareCompatible
    ? 'NOT_COMPATIBLE'
    : health.faults.length > 0
      ? 'DEVICE_FAULT'
      : batteryPercent === null
        ? 'NOT_READY_BATTERY_UNKNOWN'
        : batteryPercent <= DEVICE_READINESS_LOW_BATTERY_PERCENT
          ? 'NOT_READY_LOW_BATTERY'
          : reservationState === 'RELEASING'
            ? 'CLEANUP_PENDING'
            : reservationState === 'HELD'
              ? 'RESERVED'
              : 'READY';
  const interruptionReason =
    health.faults.length > 0
      ? 'DEVICE_FAULT'
      : batteryPercent !== null && batteryPercent <= DEVICE_INTERRUPT_LOW_BATTERY_PERCENT
        ? 'DEVICE_LOW_BATTERY'
        : null;
  return { readinessCode, interruptionReason };
}

export class DeviceRealtimeGateway {
  readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: DEVICE_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  readonly #connections = new Set<DeviceSocketConnection>();
  readonly #pendingCleanups = new Set<Promise<void>>();

  constructor(
    private readonly runtime: AuthoritativeRuntime,
    private readonly dependencies: RealtimeDependencies,
  ) {
    this.server.on('connection', (socket) => {
      try {
        this.accept(socket);
      } catch (error) {
        this.dependencies.logger.warn({ err: error }, 'Koneksi realtime perangkat gagal');
        socket.close(1011, 'Kesalahan realtime');
      }
    });
  }

  #trackCleanup(cleanup: Promise<void>): Promise<void> {
    this.#pendingCleanups.add(cleanup);
    void cleanup.then(
      () => this.#pendingCleanups.delete(cleanup),
      () => this.#pendingCleanups.delete(cleanup),
    );
    return cleanup;
  }

  private accept(socket: WebSocket): void {
    let hello: DeviceHello | null = null;
    let device: {
      credentialCiphertext: Uint8Array;
      credentialKeyVersion: number;
    } | null = null;
    let connection: AuthenticatedConnection | null = null;
    let processing = Promise.resolve();
    let closing = false;
    let cleanupPromise: Promise<void> | null = null;
    let authenticatedCleanupPromise: Promise<void> | null = null;
    const dispatches = new Set<Promise<void>>();

    const beginClose = (): void => {
      if (closing) return;
      closing = true;
      if (!connection) return;
      clearInterval(connection.commandTimer);
      clearInterval(connection.staleTimer);
    };

    const closeAuthenticated = (reason: string): Promise<void> => {
      beginClose();
      if (authenticatedCleanupPromise) return authenticatedCleanupPromise;
      if (!connection || connection.closed) return Promise.resolve();
      connection.closed = true;
      clearInterval(connection.commandTimer);
      clearInterval(connection.staleTimer);
      const authenticatedConnection = connection;
      authenticatedCleanupPromise = this.dependencies.redis
        .eval(
          RELEASE_CONNECTION_SCRIPT,
          1,
          connectionKey(authenticatedConnection.hello.deviceId),
          authenticatedConnection.connectionId,
        )
        .then(async (released) => {
          if (Number(released) !== 1) return;
          await writeDeviceReadiness(
            this.dependencies.redis,
            authenticatedConnection.hello.deviceId,
            offlineReadiness(),
          );
          await this.runtime.interruptDevice(authenticatedConnection.hello.deviceId, reason);
        });
      return this.#trackCleanup(authenticatedCleanupPromise);
    };

    const dispatchCommands = (authenticatedConnection: AuthenticatedConnection): Promise<void> => {
      const dispatch = this.dispatchCommands(authenticatedConnection);
      dispatches.add(dispatch);
      void dispatch.then(
        () => dispatches.delete(dispatch),
        () => dispatches.delete(dispatch),
      );
      return dispatch;
    };

    const cleanup = (reason: string): Promise<void> => {
      beginClose();
      if (cleanupPromise) return cleanupPromise;
      const processingAtClose = processing;
      cleanupPromise = processingAtClose
        .then(async () => {
          const settled = await Promise.allSettled([...dispatches, closeAuthenticated(reason)]);
          const failures = settled
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(rejectedReason);
          if (failures.length > 0)
            throw new AggregateError(failures, 'Device connection cleanup failed');
        })
        .finally(() => this.#connections.delete(socketConnection));
      return this.#trackCleanup(cleanupPromise);
    };
    const socketConnection: DeviceSocketConnection = { socket, cleanup };
    this.#connections.add(socketConnection);

    const cleanupAfterDisconnect = (): void => {
      void cleanup('DEVICE_DISCONNECTED').catch((error) => {
        this.dependencies.logger.warn(
          { err: error, deviceId: connection?.hello.deviceId },
          'Pemutusan perangkat gagal ditangani',
        );
      });
    };
    socket.on('close', cleanupAfterDisconnect);
    socket.on('error', () => {
      cleanupAfterDisconnect();
      socket.terminate();
    });

    socket.on('message', (data, isBinary) => {
      if (closing) return;
      processing = processing
        .then(async () => {
          if (closing) return;
          if (isBinary) {
            if (connection) await closeAuthenticated('MALFORMED_DEVICE_INPUT');
            closeProtocol(socket, 'Pesan biner tidak didukung');
            return;
          }
          const encoded = rawDataBuffer(data);
          let parsedUnknown: unknown;
          try {
            parsedUnknown = JSON.parse(encoded.toString('utf8'));
          } catch {
            if (connection) await closeAuthenticated('MALFORMED_DEVICE_INPUT');
            closeProtocol(socket, 'Format pesan tidak valid');
            return;
          }
          let message: DeviceClientMessage;
          try {
            message = parseDeviceMessage(encoded);
          } catch {
            if (connection) {
              await this.runtime.interruptAssociation(
                associationFromUnknown(parsedUnknown),
                'MALFORMED_DEVICE_INPUT',
              );
              await closeAuthenticated('MALFORMED_DEVICE_INPUT');
            }
            closeProtocol(socket, 'Pesan tidak valid');
            return;
          }

          if (!hello) {
            const parsedHello = DeviceHelloSchema.safeParse(message);
            if (!parsedHello.success) {
              closeProtocol(socket, 'Hello diperlukan');
              return;
            }
            const stored = await this.dependencies.prisma.device.findFirst({
              where: {
                deviceId: parsedHello.data.deviceId,
                institutionId: parsedHello.data.institutionId,
                inventoryStatus: 'ACTIVE',
                revokedAt: null,
              },
              select: { credentialCiphertext: true, credentialKeyVersion: true },
            });
            if (!stored) {
              closeProtocol(socket, 'Identitas perangkat ditolak');
              return;
            }
            hello = parsedHello.data;
            device = stored;
            const challenge = await issueDeviceChallenge(this.dependencies.redis, hello);
            send(
              socket,
              DeviceChallengeSchema.parse({
                protocolVersion: 1,
                type: 'device.challenge',
                messageId: randomUUID(),
                sentAtMs: Date.now(),
                sequence: 0,
                deviceId: hello.deviceId,
                payload: challenge,
              }),
            );
            return;
          }

          if (!connection) {
            const prove = DeviceProveSchema.safeParse(message);
            if (!prove.success || prove.data.deviceId !== hello.deviceId || !device) {
              closeProtocol(socket, 'Bukti perangkat ditolak');
              return;
            }
            const secret = decryptDeviceCredential(
              device.credentialCiphertext,
              device.credentialKeyVersion,
              this.dependencies.env,
            );
            if (!(await verifyDeviceProof(this.dependencies.redis, prove.data, hello, secret))) {
              closeProtocol(socket, 'Bukti perangkat ditolak');
              return;
            }
            const connectionId = randomUUID();
            const acquired = await this.dependencies.redis.set(
              connectionKey(hello.deviceId),
              connectionId,
              'EX',
              DEVICE_CONNECTION_TTL_SECONDS,
              'NX',
            );
            if (acquired !== 'OK') {
              closeProtocol(socket, 'Perangkat sudah terhubung');
              return;
            }
            await this.dependencies.prisma.device.update({
              where: { deviceId: hello.deviceId },
              data: {
                lastAuthenticatedAt: new Date(),
                firmwareVersion: hello.payload.firmwareVersion,
                capabilitySnapshot: hello.payload.capabilities,
              },
            });
            const now = Date.now();
            connection = {
              socket,
              hello,
              connectionId,
              firmwareCompatible: isDeviceFirmwareCompatible(hello.payload.firmwareVersion),
              lastHealthAtMs: now,
              dispatching: false,
              closed: false,
              commandTimer: setInterval(() => {
                if (connection)
                  void dispatchCommands(connection).catch((error) => {
                    this.dependencies.logger.warn(
                      { err: error, deviceId: connection?.hello.deviceId },
                      'Pengiriman perintah perangkat gagal',
                    );
                  });
              }, DEVICE_COMMAND_POLL_MS),
              staleTimer: setInterval(() => {
                if (connection && Date.now() - connection.lastHealthAtMs > DEVICE_STALE_AFTER_MS) {
                  void closeAuthenticated('DEVICE_HEARTBEAT_TIMEOUT').finally(() =>
                    socket.terminate(),
                  );
                }
              }, 1_000),
            };
            connection.commandTimer.unref();
            connection.staleTimer.unref();
            await writeDeviceReadiness(this.dependencies.redis, hello.deviceId, {
              connectionStatus: connection.firmwareCompatible ? 'ONLINE' : 'CONNECTING',
              readinessCode: connection.firmwareCompatible
                ? 'NOT_READY_BATTERY_UNKNOWN'
                : 'NOT_COMPATIBLE',
              firmwareVersion: hello.payload.firmwareVersion,
              capabilities: hello.payload.capabilities,
              batteryPercent: null,
              lastSeenAt: new Date(now).toISOString(),
              connectionId,
              bootId: hello.bootId,
            });
            send(
              socket,
              DeviceAcceptSchema.parse({
                protocolVersion: 1,
                type: 'device.accept',
                messageId: randomUUID(),
                sentAtMs: now,
                sequence: 0,
                deviceId: hello.deviceId,
                payload: { connectionId, heartbeatIntervalMs: 5_000, maxSequenceGap: 32 },
              }),
            );
            await dispatchCommands(connection);
            return;
          }

          if (
            message.deviceId !== connection.hello.deviceId ||
            message.type === 'device.hello' ||
            message.type === 'device.prove'
          ) {
            await closeAuthenticated('DEVICE_IDENTITY_MISMATCH');
            closeProtocol(socket, 'Identitas perangkat berubah');
            return;
          }
          const authenticated = message;
          const decision = await enforceDeviceSequence(
            this.dependencies.redis,
            connection.hello.bootId,
            authenticated,
          );
          if (decision === 'DUPLICATE') return;
          if (decision !== 'ACCEPT') {
            await this.runtime.interruptAssociation(
              associationFromUnknown(authenticated),
              `DEVICE_SEQUENCE_${decision}`,
            );
            await closeAuthenticated(`DEVICE_SEQUENCE_${decision}`);
            closeProtocol(socket, 'Urutan pesan ditolak');
            return;
          }
          const renewed = await this.dependencies.redis.eval(
            REFRESH_CONNECTION_SCRIPT,
            1,
            connectionKey(connection.hello.deviceId),
            connection.connectionId,
            String(DEVICE_CONNECTION_TTL_SECONDS),
          );
          if (Number(renewed) !== 1) {
            await closeAuthenticated('DEVICE_CONNECTION_FENCED');
            socket.terminate();
            return;
          }

          if (authenticated.type === 'device.heartbeat' || authenticated.type === 'device.status') {
            connection.lastHealthAtMs = Date.now();
            await this.updateReadiness(connection, authenticated.payload);
            return;
          }
          if (authenticated.type === 'device.commandAck') {
            await this.handleAcknowledgement(connection, authenticated);
            return;
          }
          const association =
            'setupId' in authenticated
              ? { setupId: authenticated.setupId }
              : { sessionId: authenticated.sessionId };
          if (!(await this.associationAllowed(connection.hello.deviceId, association))) {
            await this.runtime.interruptAssociation(association, 'INVALID_DEVICE_ASSOCIATION');
            await closeAuthenticated('INVALID_DEVICE_ASSOCIATION');
            closeProtocol(socket, 'Asosiasi perangkat ditolak');
            return;
          }
          const trustedInput = {
            receivedAtMs: Date.now(),
            connectionId: connection.connectionId,
            bootId: connection.hello.bootId,
            messageId: authenticated.messageId,
            sequence: authenticated.sequence,
            sentAtMs: authenticated.sentAtMs,
          };
          if (authenticated.type === 'telemetry.fsr') {
            await this.runtime.handleFsr(association, authenticated.payload.fsrRaw, trustedInput);
          } else if ('sessionId' in authenticated) {
            await this.runtime.handleButton(
              authenticated.sessionId,
              authenticated.payload.buttonCode,
              trustedInput,
            );
          } else {
            await this.runtime.interruptAssociation(association, 'INPUT_MODE_MISMATCH');
          }
        })
        .catch((error) => {
          this.dependencies.logger.warn(
            { err: error, deviceId: hello?.deviceId },
            'Pesan perangkat gagal diproses',
          );
          void closeAuthenticated('DEVICE_PROCESSING_ERROR').finally(() => socket.terminate());
        });
    });
  }

  private async associationAllowed(
    deviceId: string,
    association: { setupId?: string; sessionId?: string },
  ): Promise<boolean> {
    if (association.setupId) {
      const preparation = await this.dependencies.prisma.gamePreparation.findFirst({
        where: {
          setupId: association.setupId,
          deviceId,
          state: { in: ['CALIBRATING', 'PRACTICING', 'READY'] },
          reservation: { holderType: 'PREPARATION', state: 'HELD' },
        },
        select: { setupBoundAt: true },
      });
      return preparation?.setupBoundAt !== null && preparation?.setupBoundAt !== undefined;
    }
    if (!association.sessionId) return false;
    const session = await this.dependencies.prisma.gameSession.findFirst({
      where: {
        id: association.sessionId,
        deviceId,
        status: { in: ['COUNTDOWN', 'PLAYING', 'PAUSED'] },
        reservation: { holderType: 'SESSION', state: 'HELD' },
      },
      select: { sessionBoundAt: true },
    });
    return session?.sessionBoundAt !== null && session?.sessionBoundAt !== undefined;
  }

  private async updateReadiness(
    connection: AuthenticatedConnection,
    health: DeviceHealthPayload,
  ): Promise<void> {
    const reservation = await this.dependencies.prisma.deviceReservation.findUnique({
      where: { deviceId: connection.hello.deviceId },
      select: { state: true },
    });
    const batteryPercent = health.battery.valid ? (health.battery.percent ?? null) : null;
    const decision = decideDeviceHealth(
      health,
      reservation?.state ?? null,
      connection.firmwareCompatible,
    );
    await writeDeviceReadiness(this.dependencies.redis, connection.hello.deviceId, {
      connectionStatus: connection.firmwareCompatible ? 'ONLINE' : 'CONNECTING',
      readinessCode: decision.readinessCode,
      firmwareVersion: connection.hello.payload.firmwareVersion,
      capabilities: connection.hello.payload.capabilities,
      batteryPercent,
      lastSeenAt: new Date().toISOString(),
      connectionId: connection.connectionId,
      bootId: connection.hello.bootId,
    });
    if (decision.interruptionReason !== null) {
      await this.runtime.interruptDevice(connection.hello.deviceId, decision.interruptionReason);
    }
  }

  private async handleAcknowledgement(
    connection: AuthenticatedConnection,
    message: Extract<AuthenticatedDeviceMessage, { type: 'device.commandAck' }>,
  ): Promise<void> {
    const associationId = 'setupId' in message ? message.setupId : message.sessionId;
    const command = await this.dependencies.prisma.deviceCommand.findFirst({
      where: {
        commandId: message.payload.commandId,
        deviceId: connection.hello.deviceId,
        associationId,
      },
    });
    const status = message.payload.outcome === 'ACK' ? 'ACKED' : 'NACKED';
    const generationMismatch =
      command !== null &&
      ((command.bootId !== null && command.bootId !== connection.hello.bootId) ||
        (command.connectionId !== null && command.connectionId !== connection.connectionId));
    const duplicateOutcomeMatches =
      command?.status === status &&
      (status === 'ACKED' || command.nackReason === (message.payload.reason ?? null));
    if (
      !command ||
      generationMismatch ||
      (!duplicateOutcomeMatches &&
        (!['PENDING', 'SENT'].includes(command.status) || command.expiresAt <= new Date()))
    ) {
      await this.runtime.interruptAssociation(
        associationFromUnknown(message),
        'INVALID_COMMAND_ACK',
      );
      throw new Error('ACK perangkat tidak sesuai perintah aktif');
    }
    if (!duplicateOutcomeMatches) {
      const updated = await this.dependencies.prisma.deviceCommand.updateMany({
        where: { id: command.id, status: { in: ['PENDING', 'SENT'] } },
        data: {
          status,
          acknowledgedAt: new Date(),
          nackReason: message.payload.outcome === 'NACK' ? (message.payload.reason ?? null) : null,
        },
      });
      if (updated.count === 0) return;
    }
    if (message.payload.outcome === 'NACK') {
      await this.runtime.interruptAssociation(
        associationFromUnknown(message),
        `DEVICE_COMMAND_NACK_${message.payload.reason}`,
      );
      return;
    }
    if (command.kind === 'SETUP_BIND' && 'setupId' in message) {
      await this.runtime.handleSetupBound(message.setupId);
    } else if (command.kind === 'SETUP_UNBIND' && 'setupId' in message) {
      await this.runtime.handleSetupUnbound(message.setupId, command.commandId);
    } else if (command.kind === 'SESSION_BIND' && 'sessionId' in message) {
      await this.runtime.handleSessionBound(message.sessionId);
    } else if (command.kind === 'SESSION_UNBIND') {
      await this.dependencies.prisma.deviceReservation.deleteMany({
        where: {
          deviceId: connection.hello.deviceId,
          state: 'RELEASING',
          releaseCommandId: command.commandId,
        },
      });
      await this.updateReadiness(connection, { battery: { valid: false }, faults: [] });
    }
  }

  private async dispatchCommands(connection: AuthenticatedConnection): Promise<void> {
    if (
      connection.closed ||
      connection.dispatching ||
      connection.socket.readyState !== WebSocket.OPEN
    )
      return;
    connection.dispatching = true;
    try {
      await expireCommands(this.dependencies.prisma);
      const commands = await this.dependencies.prisma.deviceCommand.findMany({
        where: {
          deviceId: connection.hello.deviceId,
          kind: { in: [...COMMAND_KINDS] },
          status: { in: ['PENDING', 'SENT'] },
          expiresAt: { gt: new Date() },
        },
        orderBy: { sequence: 'asc' },
        take: 32,
      });
      const reservation = await this.dependencies.prisma.deviceReservation.findUnique({
        where: { deviceId: connection.hello.deviceId },
        select: { reservationId: true },
      });
      for (const command of commands) {
        if (
          command.reservationId !== null &&
          command.reservationId !== reservation?.reservationId
        ) {
          await this.dependencies.prisma.deviceCommand.updateMany({
            where: { id: command.id, status: { in: ['PENDING', 'SENT'] } },
            data: { status: 'EXPIRED' },
          });
          continue;
        }
        let wire;
        try {
          wire = commandToWire({
            commandId: command.commandId,
            deviceId: command.deviceId,
            reservationId: command.reservationId,
            associationId: command.associationId,
            sessionId: command.sessionId,
            kind: command.kind,
            sequence: command.sequence,
            payload: command.payload,
            expiresAt: command.expiresAt,
          });
        } catch {
          await this.dependencies.prisma.deviceCommand.updateMany({
            where: { id: command.id, status: { in: ['PENDING', 'SENT'] } },
            data: { status: 'EXPIRED' },
          });
          continue;
        }
        const claimed = await markCommandDispatched(
          this.dependencies.prisma,
          command.commandId,
          connection.connectionId,
          connection.hello.bootId,
        );
        if (claimed.count === 1) send(connection.socket, wire);
      }
    } finally {
      connection.dispatching = false;
    }
  }

  async close(): Promise<void> {
    const cleanups = [...this.#connections].map((connection) => {
      const cleanup = connection.cleanup('DEVICE_DISCONNECTED');
      connection.socket.terminate();
      return cleanup;
    });
    const serverClosed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    const settled = await Promise.allSettled([...cleanups, ...this.#pendingCleanups, serverClosed]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(rejectedReason);
    if (failures.length > 0) throw new AggregateError(failures, 'Device gateway cleanup failed');
  }
}
