import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { issueDeviceChallenge, verifyDeviceProof } from '../device/authentication.js';
import {
  acknowledgeMode3Command,
  commandToWire,
  deleteMode3Association,
  listMode3Commands,
  markMode3CommandDispatched,
  readMode3Association,
  readMode3Lock,
  releaseMode3Lock,
  updateMode3AssociationState,
} from '../device/commands.js';
import {
  DEVICE_MAX_MESSAGE_BYTES,
  DEVICE_STALE_AFTER_MS,
  DEVICE_SUBPROTOCOL,
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
  MODE3_DEVICE_ID,
  isDeviceFirmwareCompatible,
  offlineMode3Readiness,
  readDeviceReadiness,
  writeDeviceReadiness,
  type DeviceReadiness,
} from '../device/readiness.js';
import { enforceDeviceSequence } from '../device/sequence.js';
import type { AuthoritativeRuntime } from './runtime.js';
import type { RealtimeDependencies } from './types.js';

const CONNECTION_KEY = 'arka:{mode3}:connection';
const CONNECTION_TTL_SECONDS = 15;
const COMMAND_POLL_MS = 25;
export const DEVICE_READINESS_LOW_BATTERY_PERCENT = 10;
export const DEVICE_INTERRUPT_LOW_BATTERY_PERCENT = 10;
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
  lastHealth: DeviceHealthPayload;
  dispatching: boolean;
  closed: boolean;
  commandTimer: NodeJS.Timeout;
  staleTimer: NodeJS.Timeout;
}

interface DeviceSocketConnection {
  readonly socket: WebSocket;
  readonly cleanup: (reason: string) => Promise<void>;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function send(socket: WebSocket, message: Parameters<typeof encodeDeviceServerMessage>[0]): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeDeviceServerMessage(message));
}

function closeProtocol(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    socket.close(4400, reason.slice(0, 123));
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

export interface DeviceHealthDecision {
  readonly readinessCode: DeviceReadiness['readinessCode'];
  readonly interruptionReason: 'DEVICE_FAULT' | 'DEVICE_LOW_BATTERY' | null;
}

export function decideDeviceHealth(
  health: DeviceHealthPayload,
  lockState: 'HELD' | 'RELEASING' | null,
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
          : lockState === 'RELEASING'
            ? 'CLEANUP_PENDING'
            : lockState === 'HELD'
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
    handleProtocols: (protocols) => (protocols.has(DEVICE_SUBPROTOCOL) ? DEVICE_SUBPROTOCOL : false),
  });
  readonly #connections = new Set<DeviceSocketConnection>();
  readonly #pendingCleanups = new Set<Promise<void>>();

  constructor(
    private readonly runtime: AuthoritativeRuntime,
    private readonly dependencies: RealtimeDependencies,
  ) {
    this.server.on('connection', (socket) => this.accept(socket));
  }

  private trackCleanup(cleanup: Promise<void>): Promise<void> {
    this.#pendingCleanups.add(cleanup);
    void cleanup.finally(() => this.#pendingCleanups.delete(cleanup));
    return cleanup;
  }

  private accept(socket: WebSocket): void {
    let hello: DeviceHello | null = null;
    let connection: AuthenticatedConnection | null = null;
    let processing = Promise.resolve();
    let closing = false;
    let cleanupPromise: Promise<void> | null = null;

    const beginClose = (): void => {
      if (closing) return;
      closing = true;
      if (connection) {
        clearInterval(connection.commandTimer);
        clearInterval(connection.staleTimer);
      }
    };

    const cleanup = (reason: string): Promise<void> => {
      beginClose();
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (!connection || connection.closed) return;
        connection.closed = true;
        const released = await this.dependencies.redis.eval(
          RELEASE_CONNECTION_SCRIPT,
          1,
          CONNECTION_KEY,
          connection.connectionId,
        );
        if (Number(released) !== 1) return;
        await writeDeviceReadiness(this.dependencies.redis, offlineMode3Readiness());
        await this.runtime.interruptMode3(reason);
      })().finally(() => this.#connections.delete(socketConnection));
      return this.trackCleanup(cleanupPromise);
    };
    const socketConnection: DeviceSocketConnection = { socket, cleanup };
    this.#connections.add(socketConnection);

    const disconnected = (): void => {
      void cleanup('DEVICE_DISCONNECTED').catch((error) =>
        this.dependencies.logger.warn({ err: error }, 'Pemutusan perangkat gagal ditangani'),
      );
    };
    socket.on('close', (code, reason) => {
      this.dependencies.logger.info(
        { code, reason: reason.toString('utf8'), connectionId: connection?.connectionId ?? null },
        'Koneksi perangkat ditutup',
      );
      disconnected();
    });
    socket.on('error', (error) => {
      this.dependencies.logger.warn(
        { err: error, connectionId: connection?.connectionId ?? null },
        'Koneksi perangkat mengalami error',
      );
      disconnected();
      socket.terminate();
    });

    socket.on('message', (data, isBinary) => {
      if (closing) return;
      processing = processing
        .then(async () => {
          if (closing) return;
          if (isBinary) {
            await cleanup('MALFORMED_DEVICE_INPUT');
            closeProtocol(socket, 'Pesan biner tidak didukung');
            return;
          }
          const encoded = rawDataBuffer(data);
          let parsedUnknown: unknown;
          try {
            parsedUnknown = JSON.parse(encoded.toString('utf8'));
          } catch {
            await cleanup('MALFORMED_DEVICE_INPUT');
            closeProtocol(socket, 'Format pesan tidak valid');
            return;
          }
          let message: DeviceClientMessage;
          try {
            message = parseDeviceMessage(encoded);
          } catch {
            if (connection)
              await this.runtime.interruptAssociation(
                associationFromUnknown(parsedUnknown),
                'MALFORMED_DEVICE_INPUT',
              );
            await cleanup('MALFORMED_DEVICE_INPUT');
            closeProtocol(socket, 'Pesan tidak valid');
            return;
          }

          if (!hello) {
            const parsedHello = DeviceHelloSchema.safeParse(message);
            if (!parsedHello.success || !this.dependencies.env.MODE3_DEVICE_SECRET_BASE64) {
              closeProtocol(socket, 'Identitas perangkat ditolak');
              return;
            }
            hello = parsedHello.data;
            const challenge = await issueDeviceChallenge(this.dependencies.redis, hello);
            send(
              socket,
              DeviceChallengeSchema.parse({
                protocolVersion: 1,
                type: 'device.challenge',
                messageId: randomUUID(),
                sentAtMs: Date.now(),
                sequence: 0,
                payload: challenge,
              }),
            );
            return;
          }

          if (!connection) {
            const prove = DeviceProveSchema.safeParse(message);
            const secret = this.dependencies.env.MODE3_DEVICE_SECRET_BASE64;
            if (
              !prove.success ||
              !secret ||
              !(await verifyDeviceProof(this.dependencies.redis, prove.data, hello, secret))
            ) {
              closeProtocol(socket, 'Bukti perangkat ditolak');
              return;
            }
            const connectionId = randomUUID();
            const acquired = await this.dependencies.redis.set(
              CONNECTION_KEY,
              connectionId,
              'EX',
              CONNECTION_TTL_SECONDS,
              'NX',
            );
            if (acquired !== 'OK') {
              const readiness = await readDeviceReadiness(this.dependencies.redis);
              this.dependencies.logger.info(
                { activeConnectionId: readiness.connectionId, lastSeenAt: readiness.lastSeenAt },
                'Proof perangkat ditolak karena koneksi aktif',
              );
              closeProtocol(socket, 'Perangkat sudah terhubung');
              return;
            }
            const now = Date.now();
            connection = {
              socket,
              hello,
              connectionId,
              firmwareCompatible: isDeviceFirmwareCompatible(hello.payload.firmwareVersion),
              lastHealthAtMs: now,
              lastHealth: { battery: { valid: false }, faults: [] },
              dispatching: false,
              closed: false,
              commandTimer: setInterval(() => {
                if (connection)
                  void this.dispatchCommands(connection).catch((error) =>
                    this.dependencies.logger.warn({ err: error }, 'Pengiriman perintah gagal'),
                  );
              }, COMMAND_POLL_MS),
              staleTimer: setInterval(() => {
                if (connection && Date.now() - connection.lastHealthAtMs > DEVICE_STALE_AFTER_MS)
                  void cleanup('DEVICE_HEARTBEAT_TIMEOUT').finally(() => socket.terminate());
              }, 1_000),
            };
            connection.commandTimer.unref();
            connection.staleTimer.unref();
            await writeDeviceReadiness(this.dependencies.redis, {
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
                payload: { connectionId, heartbeatIntervalMs: 5_000, maxSequenceGap: 32 },
              }),
            );
            await this.dispatchCommands(connection);
            return;
          }

          if (message.type === 'device.hello' || message.type === 'device.prove') {
            await cleanup('UNEXPECTED_HANDSHAKE_MESSAGE');
            closeProtocol(socket, 'Pesan handshake tidak diharapkan');
            return;
          }
          const authenticated = message;
          const decision = await enforceDeviceSequence(
            this.dependencies.redis,
            MODE3_DEVICE_ID,
            connection.hello.bootId,
            authenticated,
          );
          if (decision === 'DUPLICATE') return;
          if (decision !== 'ACCEPT') {
            await this.runtime.interruptAssociation(
              associationFromUnknown(authenticated),
              `DEVICE_SEQUENCE_${decision}`,
            );
            await cleanup(`DEVICE_SEQUENCE_${decision}`);
            closeProtocol(socket, 'Urutan pesan ditolak');
            return;
          }
          const renewed = await this.dependencies.redis.eval(
            REFRESH_CONNECTION_SCRIPT,
            1,
            CONNECTION_KEY,
            connection.connectionId,
            String(CONNECTION_TTL_SECONDS),
          );
          if (Number(renewed) !== 1) {
            connection.closed = true;
            socket.terminate();
            return;
          }

          if (authenticated.type === 'device.heartbeat' || authenticated.type === 'device.status') {
            connection.lastHealthAtMs = Date.now();
            connection.lastHealth = authenticated.payload;
            await this.updateReadiness(connection);
            return;
          }
          if (authenticated.type === 'device.commandAck') {
            await this.handleAcknowledgement(connection, authenticated);
            return;
          }
          const association =
            'setupId' in authenticated
              ? { type: 'SETUP' as const, id: authenticated.setupId }
              : { type: 'SESSION' as const, id: authenticated.sessionId };
          if (!(await this.associationAllowed(association.type, association.id))) {
            await this.runtime.interruptAssociation(
              association.type === 'SETUP'
                ? { setupId: association.id }
                : { sessionId: association.id },
              'INVALID_DEVICE_ASSOCIATION',
            );
            await cleanup('INVALID_DEVICE_ASSOCIATION');
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
          const target =
            association.type === 'SETUP'
              ? { setupId: association.id }
              : { sessionId: association.id };
          if (authenticated.type === 'telemetry.fsr')
            await this.runtime.handleFsr(target, authenticated.payload.fsrRaw, trustedInput);
          else await this.runtime.handleButton(target, authenticated.payload.buttonCode, trustedInput);
        })
        .catch((error) => {
          this.dependencies.logger.warn({ err: error }, 'Pesan perangkat gagal diproses');
          void cleanup('DEVICE_PROCESSING_ERROR').finally(() => socket.terminate());
        });
    });
  }

  private async associationAllowed(type: 'SETUP' | 'SESSION', id: string): Promise<boolean> {
    const [association, lock] = await Promise.all([
      readMode3Association(this.dependencies.redis, type, id),
      readMode3Lock(this.dependencies.redis),
    ]);
    return association?.state === 'BOUND' && association.lockId === lock?.lockId;
  }

  private async updateReadiness(connection: AuthenticatedConnection): Promise<void> {
    const lock = await readMode3Lock(this.dependencies.redis);
    const health = connection.lastHealth;
    const batteryPercent = health.battery.valid ? (health.battery.percent ?? null) : null;
    const decision = decideDeviceHealth(
      health,
      lock?.state ?? null,
      connection.firmwareCompatible,
    );
    await writeDeviceReadiness(this.dependencies.redis, {
      connectionStatus: connection.firmwareCompatible ? 'ONLINE' : 'CONNECTING',
      readinessCode: decision.readinessCode,
      firmwareVersion: connection.hello.payload.firmwareVersion,
      capabilities: connection.hello.payload.capabilities,
      batteryPercent,
      lastSeenAt: new Date().toISOString(),
      connectionId: connection.connectionId,
      bootId: connection.hello.bootId,
    });
    if (decision.interruptionReason) await this.runtime.interruptMode3(decision.interruptionReason);
  }

  private async handleAcknowledgement(
    connection: AuthenticatedConnection,
    message: Extract<AuthenticatedDeviceMessage, { type: 'device.commandAck' }>,
  ): Promise<void> {
    const associationId = 'setupId' in message ? message.setupId : message.sessionId;
    const acknowledged = await acknowledgeMode3Command(this.dependencies.redis, {
      commandId: message.payload.commandId,
      associationId,
      connectionId: connection.connectionId,
      bootId: connection.hello.bootId,
      outcome: message.payload.outcome,
      ...(message.payload.reason ? { reason: message.payload.reason } : {}),
    });
    if (!acknowledged) {
      await this.runtime.interruptAssociation(associationFromUnknown(message), 'INVALID_COMMAND_ACK');
      throw new Error('ACK perangkat tidak sesuai perintah aktif');
    }
    if (acknowledged.duplicate) return;
    const command = acknowledged.command;
    if (message.payload.outcome === 'NACK') {
      await this.runtime.interruptAssociation(
        associationFromUnknown(message),
        `DEVICE_COMMAND_NACK_${message.payload.reason}`,
      );
      return;
    }
    if (command.kind === 'SETUP_BIND' && 'setupId' in message) {
      await updateMode3AssociationState(
        this.dependencies.redis,
        'SETUP',
        message.setupId,
        command.lockId,
        'BOUND',
      );
      await this.runtime.handleSetupBound(message.setupId);
    } else if (command.kind === 'SETUP_UNBIND' && 'setupId' in message) {
      await deleteMode3Association(this.dependencies.redis, 'SETUP', message.setupId);
      await this.runtime.handleSetupUnbound(message.setupId, command.commandId);
    } else if (command.kind === 'SESSION_BIND' && 'sessionId' in message) {
      await updateMode3AssociationState(
        this.dependencies.redis,
        'SESSION',
        message.sessionId,
        command.lockId,
        'BOUND',
      );
      await this.runtime.handleSessionBound(message.sessionId);
    } else if (command.kind === 'SESSION_UNBIND' && 'sessionId' in message) {
      await deleteMode3Association(this.dependencies.redis, 'SESSION', message.sessionId);
      await releaseMode3Lock(this.dependencies.redis, command.lockId);
      await this.updateReadiness(connection);
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
      const lock = await readMode3Lock(this.dependencies.redis);
      for (const command of await listMode3Commands(this.dependencies.redis)) {
        if (!lock || command.lockId !== lock.lockId) continue;
        const claimed = await markMode3CommandDispatched(
          this.dependencies.redis,
          command,
          connection.connectionId,
          connection.hello.bootId,
        );
        if (claimed) send(connection.socket, commandToWire(claimed));
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
    const serverClosed = new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    const settled = await Promise.allSettled([...cleanups, ...this.#pendingCleanups, serverClosed]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) throw new AggregateError(failures, 'Device gateway cleanup failed');
  }
}
