import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Express } from 'express';
import { ParticipantController } from './participant.controller.js';
import { createParticipantRouter } from './participant.routes.js';
import type { ParticipantService } from './participant.service.js';

const participant = {
  participantId: 'participant_public_handle_1234567890',
  displayName: 'Andrian',
  participantReference: 'AUTO-andrian',
  status: 'ACTIVE' as const,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
};

function createApp(): Express {
  const service = {
    searchParticipants: async (_institutionId: string, query: string) =>
      query.toLocaleLowerCase('id-ID').includes('andrian') ? [participant] : [],
    createParticipant: async (_scope: unknown, displayName: string) => ({
      ...participant,
      displayName,
    }),
  } as unknown as ParticipantService;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authContext = {
      institutionId: 'institution-id',
      userId: 'user-id',
      sessionId: 'session-id',
    } as NonNullable<typeof req.authContext>;
    req.requestId = 'request-id';
    next();
  });
  app.use(createParticipantRouter(new ParticipantController(service)));
  return app;
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('searches active participants by name', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/participants?query=Andrian`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [participant]);
  });
});

test('creates a participant with a generated identity', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/participants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Calvin' }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ...participant, displayName: 'Calvin' });
  });
});
