import assert from 'node:assert/strict';
import test from 'node:test';
import type { DashboardRepository } from './dashboard.repository.js';
import { DashboardService } from './dashboard.service.js';

test('maps seven ordered activity days including empty days', async () => {
  const repository = {
    activity: async () => ({
      activeParticipants: 2,
      savedSessionsTotal: 3,
      savedSessionsLast7Days: 2,
      latestSavedAt: new Date('2026-07-30T12:00:00.000Z'),
      dailySavedSessions: [
        { date: '2026-07-24', savedSessions: 0 },
        { date: '2026-07-25', savedSessions: 0 },
        { date: '2026-07-26', savedSessions: 1 },
        { date: '2026-07-27', savedSessions: 0 },
        { date: '2026-07-28', savedSessions: 0 },
        { date: '2026-07-29', savedSessions: 0 },
        { date: '2026-07-30', savedSessions: 1 },
      ],
      modes: [
        { mode: 'MOTOR_GRIP' as const, savedSessions: 1, sessionsLast7Days: 1, latestSavedAt: null, latestRuleVersion: null },
        { mode: 'GO_NO_GO' as const, savedSessions: 1, sessionsLast7Days: 0, latestSavedAt: null, latestRuleVersion: null },
        { mode: 'SEQUENCE_MEMORY' as const, savedSessions: 1, sessionsLast7Days: 1, latestSavedAt: null, latestRuleVersion: null },
      ],
    }),
  } as unknown as DashboardRepository;

  const result = await new DashboardService(repository).activity('institution-id');

  assert.equal(result.dailySavedSessions.length, 7);
  assert.deepEqual(result.dailySavedSessions[0], { date: '2026-07-24', savedSessions: 0 });
  assert.equal(result.dailySavedSessions.reduce((sum, day) => sum + day.savedSessions, 0), 2);
});

test('maps personal progress without participant ranking', async () => {
  const repository = {
    progress: async () => ({
      generatedAt: new Date('2026-07-30T00:00:00.000Z'),
      participants: [
        {
          participantId: 'participant_handle_1234567890',
          displayName: 'Ibu Sari',
          savedSessionsTotal: 4,
          sessionsLast7Days: 1,
          activeWeeksLast4: 3,
          latest: {
            mode: 'MOTOR_GRIP' as const,
            completedAt: new Date('2026-07-29T00:00:00.000Z'),
            score: 720,
            gameRuleVersion: 'motor-v1',
            sessionId: '00000000-0000-4000-8000-000000000001',
          },
          previousComparableScore: 680,
        },
      ],
    }),
  } as unknown as DashboardRepository;

  const result = await new DashboardService(repository).progress('institution-id');

  assert.equal(result.participants[0]?.progress.status, 'IMPROVED');
  assert.equal(result.participants[0]?.achievementStatus, 'IMPROVED');
  assert.equal('rank' in (result.participants[0] ?? {}), false);
  assert.equal('score' in (result.participants[0] ?? {}), false);
});
