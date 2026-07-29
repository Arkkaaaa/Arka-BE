import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Env } from '../config/env.js';
import { encryptDeviceCredential } from '../device/authentication.js';
import type { DeviceHealthPayload } from '../device/protocol.js';
import type { DeviceReadiness } from '../device/readiness.js';
import type { AuthoritativeRuntime } from './runtime.js';
import { decideDeviceHealth, DeviceRealtimeGateway } from './device-gateway.js';
import type { RealtimeDependencies } from './types.js';

const DEVICE_ID = 'jalin-demo-001';
const INSTITUTION_ID = '018f2f6e-7b23-7f6b-9238-0242ac120003';
const BOOT_ID = '018f2f6e-7b23-7f6b-9238-0242ac120004';

function batteryHealth(percent: number): DeviceHealthPayload {
  return { battery: { valid: true, percent }, faults: [] };
}

describe('device gateway battery policy', () => {
  it('marks the inclusive 30 percent readiness boundary low without interrupting', () => {
    expect(decideDeviceHealth(batteryHealth(30), null, true)).toEqual({
      readinessCode: 'NOT_READY_LOW_BATTERY',
      interruptionReason: null,
    });
    expect(decideDeviceHealth(batteryHealth(31), null, true)).toEqual({
      readinessCode: 'READY',
      interruptionReason: null,
    });
  });

  it('interrupts at the inclusive 10 percent safety boundary only', () => {
    expect(decideDeviceHealth(batteryHealth(10), null, true)).toEqual({
      readinessCode: 'NOT_READY_LOW_BATTERY',
      interruptionReason: 'DEVICE_LOW_BATTERY',
    });
    expect(decideDeviceHealth(batteryHealth(11), null, true)).toEqual({
      readinessCode: 'NOT_READY_LOW_BATTERY',
      interruptionReason: null,
    });
  });
});

class FakeDeviceSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function testEnv(): Env {
  return {
    DEVICE_CREDENTIAL_KEYS: new Map([[1, Buffer.alloc(32, 7)]]),
  } as Env;
}

function gatewayHarness(
  firmwareVersion: string,
  interruptDevice = vi.fn().mockResolvedValue(undefined),
) {
  const env = testEnv();
  const secret = Buffer.alloc(32, 9);
  const credentialCiphertext = encryptDeviceCredential(secret, 1, env);
  const values = new Map<string, string>();
  const readinessWrites: DeviceReadiness[] = [];
  const redis = {
    set: vi.fn((key: string, value: string) => {
      if (key.startsWith('jalin:device:readiness:')) {
        readinessWrites.push(JSON.parse(value) as DeviceReadiness);
      } else {
        values.set(key, value);
      }
      return Promise.resolve('OK');
    }),
    call: vi.fn((command: string, key: string) => {
      if (command !== 'GETDEL') return Promise.resolve(null);
      const value = values.get(key) ?? null;
      values.delete(key);
      return Promise.resolve(value);
    }),
    eval: vi.fn((_script: string, keyCount: number) =>
      Promise.resolve(keyCount === 4 ? 'ACCEPT' : 1),
    ),
  } as unknown as Redis;
  const dependencies = {
    env,
    redis,
    prisma: {
      device: {
        findFirst: vi.fn().mockResolvedValue({ credentialCiphertext, credentialKeyVersion: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      deviceCommand: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      deviceReservation: { findUnique: vi.fn().mockResolvedValue(null) },
    },
    logger: { warn: vi.fn() },
  } as unknown as RealtimeDependencies;
  const runtime = {
    interruptDevice,
  } as unknown as AuthoritativeRuntime;
  const gateway = new DeviceRealtimeGateway(runtime, dependencies);
  const socket = new FakeDeviceSocket();
  gateway.server.emit('connection', socket);

  const hello = {
    protocolVersion: 1,
    type: 'device.hello',
    messageId: '018f2f6e-7b23-7f6b-9238-0242ac120002',
    sentAtMs: Date.now(),
    sequence: 0,
    deviceId: DEVICE_ID,
    institutionId: INSTITUTION_ID,
    bootId: BOOT_ID,
    payload: { firmwareVersion, capabilities: ['FSR_10HZ', 'BUTTONS_4', 'LED'] },
  };

  async function authenticate(): Promise<void> {
    socket.emit('message', Buffer.from(JSON.stringify(hello)), false);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const challenge = JSON.parse(socket.sent[0]!) as {
      payload: { challengeId: string; nonce: string };
    };
    const material = `jalin-device-v1\n${challenge.payload.challengeId}\n${challenge.payload.nonce}\n${DEVICE_ID}\n${INSTITUTION_ID}\n${BOOT_ID}`;
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          protocolVersion: 1,
          type: 'device.prove',
          messageId: '018f2f6e-7b23-7f6b-9238-0242ac120010',
          sentAtMs: Date.now(),
          sequence: 0,
          deviceId: DEVICE_ID,
          payload: {
            challengeId: challenge.payload.challengeId,
            proof: createHmac('sha256', secret).update(material).digest('base64url'),
          },
        }),
      ),
      false,
    );
    await vi.waitFor(() => expect(readinessWrites).toHaveLength(1));
  }

  async function sendHealthyHeartbeat(): Promise<void> {
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          protocolVersion: 1,
          type: 'device.heartbeat',
          messageId: '018f2f6e-7b23-7f6b-9238-0242ac120011',
          sentAtMs: Date.now(),
          sequence: 1,
          deviceId: DEVICE_ID,
          payload: batteryHealth(90),
        }),
      ),
      false,
    );
    await vi.waitFor(() => expect(readinessWrites).toHaveLength(2));
  }

  return { authenticate, gateway, interruptDevice, readinessWrites, sendHealthyHeartbeat, socket };
}

describe('device gateway firmware compatibility', () => {
  it('keeps an authenticated incompatible device NOT_COMPATIBLE after healthy telemetry', async () => {
    const harness = gatewayHarness('1.0.0');

    await harness.authenticate();
    expect(harness.readinessWrites[0]).toMatchObject({
      connectionStatus: 'CONNECTING',
      readinessCode: 'NOT_COMPATIBLE',
      firmwareVersion: '1.0.0',
    });

    await harness.sendHealthyHeartbeat();
    expect(harness.readinessWrites[1]).toMatchObject({
      connectionStatus: 'CONNECTING',
      readinessCode: 'NOT_COMPATIBLE',
      batteryPercent: 90,
    });
    harness.socket.emit('close');
  });

  it('preserves battery readiness behavior for authenticated firmware 0.1.0', async () => {
    const harness = gatewayHarness('0.1.0');

    await harness.authenticate();
    expect(harness.readinessWrites[0]).toMatchObject({
      connectionStatus: 'ONLINE',
      readinessCode: 'NOT_READY_BATTERY_UNKNOWN',
      firmwareVersion: '0.1.0',
    });

    await harness.sendHealthyHeartbeat();
    expect(harness.readinessWrites[1]).toMatchObject({
      connectionStatus: 'ONLINE',
      readinessCode: 'READY',
      batteryPercent: 90,
    });
    harness.socket.emit('close');
  });
});

describe('device gateway shutdown', () => {
  it('does not finish before authenticated disconnect safety cleanup settles', async () => {
    const interruption = Promise.withResolvers<void>();
    const interruptDevice = vi.fn(() => interruption.promise);
    const harness = gatewayHarness('0.1.0', interruptDevice);

    await harness.authenticate();
    let closed = false;
    const closing = harness.gateway.close().then(() => {
      closed = true;
    });

    await vi.waitFor(() =>
      expect(interruptDevice).toHaveBeenCalledWith(DEVICE_ID, 'DEVICE_DISCONNECTED'),
    );
    expect(closed).toBe(false);

    interruption.resolve();
    await closing;
    expect(closed).toBe(true);
  });
});
