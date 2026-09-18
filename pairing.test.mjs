import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { DeviceRealtimeGateway } from './src/realtime/device-gateway.ts';
import { AuthoritativeRuntime } from './src/realtime/runtime.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail('Expected asynchronous operation did not complete');
}

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(encoded) { this.sent.push(JSON.parse(encoded)); }
  close(code, reason) { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
  terminate() { if (this.readyState !== 3) this.close(1006, 'terminated'); }
  message(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}

function fixture() {
  const values = new Map();
  const sequences = new Map();
  const messages = new Set();
  const warnings = [];
  const interruptions = [];
  const telemetry = [];
  const setupId = randomUUID();
  const lockId = randomUUID();
  const bootId = randomUUID();
  const secret = Buffer.alloc(32, 7);
  let associationGate;
  let associationReads = 0;
  const redis = {
    async get(key) {
      if (key.includes(':association:')) {
        associationReads += 1;
        if (associationGate) await associationGate.promise;
      }
      return values.get(key) ?? null;
    },
    async set(key, value, ...args) {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async call(_command, key) { const value = values.get(key); values.delete(key); return value ?? null; },
    async zrange() { return []; },
    async eval(script, count, ...args) {
      const keys = args.slice(0, count);
      const argv = args.slice(count);
      if (script.includes('local sequenceKey')) {
        const current = sequences.get(keys[0]) ?? 0;
        const proposed = Number(argv[0]);
        if (messages.has(keys[1])) return 'DUPLICATE';
        if (proposed <= current) return 'STALE';
        if (proposed - current > Number(argv[1]) && argv[4] !== '1') return 'GAP';
        sequences.set(keys[0], proposed);
        messages.add(keys[1]);
        return 'ACCEPT';
      }
      if (values.get(keys[0]) !== argv[0]) return 0;
      if (script.includes("redis.call('DEL'")) values.delete(keys[0]);
      return 1;
    },
  };
  const runtime = {
    async interruptDeviceFamily(_family, reason) { interruptions.push(reason); },
    async interruptAssociation(_family, _association, reason) { interruptions.push(reason); },
    async handleFsr(...args) { telemetry.push(args); },
  };
  const gateway = new DeviceRealtimeGateway(runtime, {
    redis,
    env: { DEVICE_SECRET_BASE64: secret },
    logger: { info() {}, warn(...args) { warnings.push(args); } },
  });
  const envelope = (type, sequence, payload, extra = {}) => ({
    protocolVersion: 1, type, sequence, messageId: randomUUID(), sentAtMs: Date.now(), payload, ...extra,
  });
  async function connect() {
    const socket = new Socket();
    gateway.server.emit('connection', socket);
    socket.message(envelope('device.hello', 0, {
      firmwareVersion: '0.2.9', capabilities: ['FSR_10HZ', 'FSR_TARED_ON_SETUP_BIND'],
    }, { bootId }));
    await until(() => socket.sent.some((message) => message.type === 'device.challenge'));
    const challenge = socket.sent.find((message) => message.type === 'device.challenge').payload;
    const proof = createHmac('sha256', secret)
      .update(`arka-device-v1\n${challenge.challengeId}\n${challenge.nonce}\n${bootId}`)
      .digest('base64url');
    socket.message(envelope('device.prove', 0, { challengeId: challenge.challengeId, proof }));
    await until(() => socket.sent.some((message) => message.type === 'device.accept'));
    return socket;
  }
  return {
    gateway, connect, envelope, setupId, lockId, values, sequences, warnings, interruptions, telemetry,
    blockAssociation() { associationGate = deferred(); return associationGate; },
    get associationReads() { return associationReads; },
  };
}

const health = { battery: { valid: true, percent: 100 }, faults: [] };

function handoffFixture() {
  const setupId = randomUUID();
  const sessionId = randomUUID();
  const lock = {
    lockId: randomUUID(), institutionId: randomUUID(), ownerSessionId: 'owner',
    holderType: 'SESSION', preparationId: 'preparation-identifier-long', setupId,
    sessionId, state: 'HELD', expiresAtMs: Date.now() + 30_000,
  };
  const deleted = [];
  const redis = {
    async get() { return JSON.stringify(lock); },
    async zrange() { return []; },
    async del(...keys) { deleted.push(...keys); },
    async eval() { deleted.push('lock'); return 1; },
  };
  const prisma = { trGameSession: { async findFirst() { return null; } } };
  const runtime = new AuthoritativeRuntime({ redis, prisma, logger: {} });
  return { runtime, prisma, setupId, sessionId, lock, deleted };
}

test('setup unbind creates a session bind with the same reservation and binding deadline', async () => {
  const f = handoffFixture();
  const deadline = new Date(Date.now() + 20_000);
  const values = new Map();
  const queued = [];
  f.prisma.trGameSession.findFirst = async () => ({
    id: f.sessionId, mode: 'MOTOR_GRIP', bindingDeadlineAt: deadline,
  });
  f.runtime.loadSession = async () => ({ lockId: f.lock.lockId });
  f.runtime.dependencies.redis.get = async (key) => key.endsWith(':lock')
    ? JSON.stringify(f.lock)
    : values.get(key) ?? null;
  f.runtime.dependencies.redis.set = async (key, value) => { values.set(key, value); return 'OK'; };
  f.runtime.dependencies.redis.eval = async (_script, count, ...args) => {
    const existing = values.get(args[3]);
    if (existing) return existing;
    const command = { ...JSON.parse(args[count]), sequence: queued.length + 1 };
    queued.push(command);
    values.set(args[3], JSON.stringify(command));
    return JSON.stringify(command);
  };
  const commandId = randomUUID();
  await f.runtime.handleSetupUnbound('GAME12', f.setupId, commandId);
  await f.runtime.handleSetupUnbound('GAME12', f.setupId, commandId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'SESSION_BIND');
  assert.equal(queued[0].associationId, f.sessionId);
  assert.equal(queued[0].lockId, f.lock.lockId);
  assert.equal(queued[0].expiresAtMs, deadline.getTime());
  assert.equal(JSON.parse(values.get(`arka:{game12}:association:session:${f.sessionId}`)).state, 'BINDING');
});

test('late setup unbind ACK cannot release a held session reservation', async () => {
  const f = handoffFixture();
  await f.runtime.handleSetupUnbound('GAME12', f.setupId, randomUUID());
  assert.deepEqual(f.deleted, []);
});

test('setup cleanup ACK releases a terminating session reservation', async () => {
  const f = handoffFixture();
  f.lock.state = 'RELEASING';
  await f.runtime.handleSetupUnbound('GAME12', f.setupId, randomUUID());
  assert.ok(f.deleted.includes('lock'));
});

test('setup cleanup ACK cannot release another setup reservation', async () => {
  const f = handoffFixture();
  f.lock.state = 'RELEASING';
  await f.runtime.handleSetupUnbound('GAME12', randomUUID(), randomUUID());
  assert.deepEqual(f.deleted, []);
});

test('setup handoff waits for an in-flight session mutation and rechecks durable binding state', async () => {
  const f = handoffFixture();
  const gate = deferred();
  const entered = deferred();
  let binding = true;
  let handoffReads = 0;
  f.prisma.trGameSession.findFirst = async () => binding
    ? { id: f.sessionId, mode: 'MOTOR_GRIP' }
    : null;
  f.runtime.loadSession = async () => { handoffReads += 1; return null; };
  f.runtime.companionRefreshedUnlocked = async () => {
    entered.resolve();
    await gate.promise;
    binding = false;
  };
  const mutation = f.runtime.companionRefreshed(f.sessionId, 'owner', 'connection');
  await entered.promise;
  const handoff = f.runtime.handleSetupUnbound('GAME12', f.setupId, randomUUID());
  await nextTurn();
  const readsBeforeRelease = handoffReads;
  gate.resolve();
  await Promise.all([mutation, handoff]);
  assert.equal(readsBeforeRelease, 0);
  assert.equal(handoffReads, 0);
  assert.deepEqual(f.deleted, []);
});

test('slow FSR association reads do not block the following command ACK', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  const socket = await f.connect();
  const gate = f.blockAssociation();
  t.after(() => gate.resolve());
  const acknowledgements = [];
  f.gateway.handleAcknowledgement = async (_connection, message) => acknowledgements.push(message);
  socket.message(f.envelope('telemetry.fsr', 1, { fsrRaw: 0 }, { setupId: f.setupId }));
  await until(() => f.associationReads === 1);
  socket.message(f.envelope('device.commandAck', 2, { commandId: randomUUID(), outcome: 'ACK' }, { setupId: f.setupId }));
  await until(() => acknowledgements.length === 1);
  assert.equal(acknowledgements[0].sequence, 2);
  gate.resolve();
  await nextTurn();
  await nextTurn();
  assert.equal(socket.readyState, 1);
  assert.deepEqual(f.interruptions, []);
  assert.deepEqual(f.telemetry, []);
});

test('fresh authenticated reconnect recovers a forward sequence gap without a firmware reboot', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  const first = await f.connect();
  first.message(f.envelope('device.status', 1, health));
  await until(() => [...f.sequences.values()].includes(1));
  first.terminate();
  await until(() => ![...f.values.keys()].some((key) => key.endsWith(':connection')));
  const second = await f.connect();
  second.message(f.envelope('device.status', 100, health));
  await until(() => [...f.sequences.values()].includes(100) || second.readyState === 3);
  assert.equal(second.readyState, 1);
  assert.ok([...f.sequences.values()].includes(100));
  second.message(f.envelope('device.heartbeat', 101, health));
  await until(() => [...f.sequences.values()].includes(101));
  assert.deepEqual(f.interruptions, ['DEVICE_DISCONNECTED']);
});

test('forward gaps inside an authenticated connection are still rejected', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  const socket = await f.connect();
  socket.message(f.envelope('device.status', 1, health));
  socket.message(f.envelope('device.heartbeat', 100, health));
  await until(() => socket.readyState === 3);
  assert.ok(f.interruptions.includes('DEVICE_SEQUENCE_GAP'));
});

test('reconnect does not accept a stale sequence', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  const first = await f.connect();
  first.message(f.envelope('device.status', 10, health));
  await until(() => [...f.sequences.values()].includes(10));
  first.terminate();
  await until(() => ![...f.values.keys()].some((key) => key.endsWith(':connection')));
  const second = await f.connect();
  second.message(f.envelope('device.status', 9, health));
  await until(() => second.readyState === 3);
  assert.ok(f.interruptions.includes('DEVICE_SEQUENCE_STALE'));
});

test('telemetry cannot resynchronize the first authenticated sequence', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  const socket = await f.connect();
  socket.message(f.envelope('telemetry.fsr', 100, { fsrRaw: 0 }, { setupId: f.setupId }));
  await until(() => socket.readyState === 3);
  assert.ok(f.interruptions.includes('DEVICE_SEQUENCE_GAP'));
});

test('unknown associations still close the connection', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  const socket = await f.connect();
  socket.message(f.envelope('telemetry.fsr', 1, { fsrRaw: 0 }, { setupId: f.setupId }));
  await until(() => socket.readyState === 3);
  assert.ok(f.interruptions.includes('INVALID_DEVICE_ASSOCIATION'));
});

test('FSR processing coalesces pending samples while preserving ordered sequence validation', async (t) => {
  const f = fixture();
  t.after(() => f.gateway.close());
  f.values.set('arka:{game12}:lock', JSON.stringify({
    lockId: f.lockId, institutionId: randomUUID(), ownerSessionId: 'owner',
    holderType: 'PREPARATION', preparationId: 'preparation-identifier-long',
    setupId: f.setupId, sessionId: null, state: 'HELD', expiresAtMs: Date.now() + 30_000,
  }));
  f.values.set(`arka:{game12}:association:setup:${f.setupId}`, JSON.stringify({
    lockId: f.lockId, associationId: f.setupId, type: 'SETUP', state: 'BOUND',
  }));
  const socket = await f.connect();
  const gate = f.blockAssociation();
  t.after(() => gate.resolve());
  socket.message(f.envelope('telemetry.fsr', 1, { fsrRaw: 1 }, { setupId: f.setupId }));
  await until(() => f.associationReads === 1);
  for (let sequence = 2; sequence <= 10; sequence += 1) {
    socket.message(f.envelope('telemetry.fsr', sequence, { fsrRaw: sequence }, { setupId: f.setupId }));
  }
  await until(() => [...f.sequences.values()].includes(10));
  await nextTurn();
  gate.resolve();
  await until(() => f.telemetry.length === 2);
  assert.deepEqual(f.telemetry.map((args) => args[2]), [1, 10]);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(f.warnings, []);
});

for (const first of ['device', 'companion']) {
  test(`binding enters countdown exactly once when ${first} arrives first`, async () => {
    let stored = {
      sessionId: randomUUID(), ownerSessionId: 'owner', mode: 'MOTOR_GRIP',
      status: 'BINDING', deviceBound: false, companionPresent: false,
    };
    let durableStatus = 'BINDING';
    let sessionBound = false;
    let present = false;
    let activations = 0;
    const prisma = {
      trGameSession: {
        async findFirst({ where }) {
          if (durableStatus !== 'BINDING') return null;
          if (where.sessionBoundAt && !sessionBound) return null;
          return { id: stored.sessionId };
        },
        async updateMany({ data }) {
          if (durableStatus !== 'BINDING') return { count: 0 };
          if (data.sessionBoundAt) sessionBound = true;
          if (data.status === 'COUNTDOWN') { durableStatus = data.status; activations += 1; }
          return { count: 1 };
        },
      },
    };
    const runtime = new AuthoritativeRuntime({ redis: {}, prisma, logger: {} });
    runtime.loadSession = async () => structuredClone(stored);
    runtime.saveSession = async (value) => { stored = structuredClone(value); };
    runtime.publishSession = async () => {};
    runtime.addCompanionPresence = async () => { present = true; };
    runtime.countCompanionPresence = async () => present ? 1 : 0;
    const device = () => runtime.handleSessionBound('GAME12', stored.sessionId);
    const companion = () => runtime.companionArrived(stored.sessionId, 'owner', 'connection');
    const arrivals = first === 'device' ? [device, companion] : [companion, device];
    await arrivals[0]();
    assert.equal(stored.status, 'BINDING');
    await arrivals[1]();
    await device();
    assert.equal(stored.status, 'COUNTDOWN');
    assert.equal(stored.deviceBound, true);
    assert.equal(stored.companionPresent, true);
    assert.equal(activations, 1);
  });
}

test('session binding ACK waits for an in-flight companion mutation', async () => {
  const runtime = new AuthoritativeRuntime({ redis: {}, prisma: {}, logger: {} });
  const gate = deferred();
  const entered = deferred();
  const order = [];
  runtime.companionRefreshedUnlocked = async () => {
    order.push('companion:start');
    entered.resolve();
    await gate.promise;
    order.push('companion:end');
  };
  runtime.dependencies.prisma.trGameSession = {
    async updateMany() { order.push('bound'); return { count: 0 }; },
  };
  const companion = runtime.companionRefreshed('session', 'owner', 'connection');
  await entered.promise;
  const binding = runtime.handleSessionBound('GAME12', 'session');
  await nextTurn();
  const beforeRelease = [...order];
  gate.resolve();
  await Promise.all([companion, binding]);
  assert.deepEqual(beforeRelease, ['companion:start']);
  assert.deepEqual(order, ['companion:start', 'companion:end', 'bound']);
});
