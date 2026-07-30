import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DeviceHelloSchema } from './protocol.js';

function hello() {
  return {
    protocolVersion: 1,
    type: 'device.hello',
    messageId: randomUUID(),
    sentAtMs: Date.now(),
    sequence: 0,
    bootId: randomUUID(),
    payload: { firmwareVersion: 'test', capabilities: ['BUTTONS_4'] },
  };
}

test('accepts singleton Mode 3 hello without identifiers', () => {
  assert.equal(DeviceHelloSchema.safeParse(hello()).success, true);
});

test('rejects legacy device and institution identifiers on the wire', () => {
  assert.equal(DeviceHelloSchema.safeParse({ ...hello(), deviceId: 'legacy-device' }).success, false);
  assert.equal(DeviceHelloSchema.safeParse({ ...hello(), institutionId: randomUUID() }).success, false);
});
