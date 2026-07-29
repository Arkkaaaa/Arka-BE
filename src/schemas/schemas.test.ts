import { describe, expect, it } from 'vitest';
import {
  AppClientMessageSchema,
  AuthCapabilitiesDtoSchema,
  AppServerMessageSchema,
  CreatePreparationRequestSchema,
  GameMetricsSchema,
  HistoryPageDtoSchema,
  UpdateParticipantRequestSchema,
} from './index.js';

const messageId = '018f2f6e-7b23-7f6b-9238-0242ac120010';
const setupId = '018f2f6e-7b23-7f6b-9238-0242ac120011';

describe('browser request schemas', () => {
  it('requires explicit privacy acknowledgement when creating preparation input', () => {
    const input = {
      mode: 'MOTOR_GRIP',
      displayName: 'Ibu Sari',
      participantReference: 'JLN-001',
    };

    expect(CreatePreparationRequestSchema.safeParse(input).success).toBe(false);
    expect(
      CreatePreparationRequestSchema.parse({ ...input, privacyAcknowledged: false }),
    ).toMatchObject({ privacyAcknowledged: false });
  });

  it('requires at least one participant change', () => {
    expect(UpdateParticipantRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateParticipantRequestSchema.parse({ status: 'INACTIVE' })).toEqual({
      status: 'INACTIVE',
    });
  });
});

describe('auth capability API', () => {
  it.each([false, true])('accepts google=%s', (google) => {
    expect(
      AuthCapabilitiesDtoSchema.parse({
        emailPassword: true,
        registration: true,
        socialProviders: { google },
      }),
    ).toEqual({
      emailPassword: true,
      registration: true,
      socialProviders: { google },
    });
  });

  it.each([
    {},
    { emailPassword: false, registration: true, socialProviders: { google: false } },
    { emailPassword: true, registration: false, socialProviders: { google: false } },
    { emailPassword: true, registration: true, socialProviders: {} },
    {
      emailPassword: true,
      registration: true,
      socialProviders: { google: true, clientId: 'must-not-be-public' },
    },
  ])('rejects malformed payload %#', (payload) => {
    expect(AuthCapabilitiesDtoSchema.safeParse(payload).success).toBe(false);
  });
});

describe('game result schemas', () => {
  it('keeps metrics discriminated by game mode', () => {
    expect(
      GameMetricsSchema.parse({
        mode: 'MOTOR_GRIP',
        peakGripPercent: 82,
        continuousHoldMs: 5_000,
        targetCompleted: true,
        sessionElapsedMs: 7_500,
      }).mode,
    ).toBe('MOTOR_GRIP');

    expect(
      GameMetricsSchema.safeParse({
        mode: 'MOTOR_GRIP',
        totalTrials: 10,
        targetTrials: 4,
        nonTargetTrials: 6,
        hits: 4,
        misses: 0,
        falsePositives: 1,
        correctRejections: 5,
        accuracyPercent: 90,
        meanHitReactionMs: 420,
      }).success,
    ).toBe(false);
  });

  it('caps history pages at ten entries', () => {
    expect(
      HistoryPageDtoSchema.safeParse({
        items: Array.from({ length: 11 }, () => ({})),
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('realtime wire schemas', () => {
  it('accepts setup subscriptions and rejects invalid command discriminators', () => {
    expect(
      AppClientMessageSchema.parse({
        protocolVersion: 1,
        messageId,
        type: 'app.setup.subscribe',
        payload: { setupId, cursor: 0 },
      }).type,
    ).toBe('app.setup.subscribe');

    expect(
      AppClientMessageSchema.safeParse({
        protocolVersion: 1,
        messageId,
        type: 'session.command',
        payload: { sessionId: setupId, command: 'START' },
      }).success,
    ).toBe(false);
  });

  it('keeps snapshots bound to the matching visual mode', () => {
    const snapshot = {
      protocolVersion: 1,
      sequence: 1,
      type: 'session.snapshot',
      sessionId: setupId,
      payload: {
        status: 'PLAYING',
        mode: 'GO_NO_GO',
        displayName: 'Ibu Sari',
        countdown: null,
        visual: {
          mode: 'GO_NO_GO',
          trialNumber: 1,
          stimulus: 'WAYANG',
          phase: 'STIMULUS',
          feedback: null,
          correctTrials: 0,
        },
        result: null,
        message: 'Genggam hanya untuk Wayang',
      },
    };

    expect(AppServerMessageSchema.parse(snapshot).type).toBe('session.snapshot');
    expect(
      AppServerMessageSchema.safeParse({
        ...snapshot,
        payload: {
          ...snapshot.payload,
          visual: { ...snapshot.payload.visual, mode: 'MOTOR_GRIP' },
        },
      }).success,
    ).toBe(false);
  });
});
