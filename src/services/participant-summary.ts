import { GameMetricsSchema, type GameMetrics } from '../schemas/index.js';
import type { Prisma } from '../generated/prisma/client.js';

interface ResultInput {
  readonly score: number;
  readonly metrics: unknown;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildParticipantAggregate(results: readonly ResultInput[]) {
  const parsed = results.flatMap((result) => {
    const metrics = GameMetricsSchema.safeParse(result.metrics);
    return metrics.success ? [{ score: result.score, metrics: metrics.data }] : [];
  });
  const motor = parsed.filter((item): item is { score: number; metrics: Extract<GameMetrics, { mode: 'MOTOR_GRIP' }> } => item.metrics.mode === 'MOTOR_GRIP');
  const attention = parsed.filter((item): item is { score: number; metrics: Extract<GameMetrics, { mode: 'GO_NO_GO' }> } => item.metrics.mode === 'GO_NO_GO');
  const memory = parsed.filter((item): item is { score: number; metrics: Extract<GameMetrics, { mode: 'SEQUENCE_MEMORY' }> } => item.metrics.mode === 'SEQUENCE_MEMORY');
  const aggregate = {
    sessions: parsed.length,
    motorGrip: {
      sessions: motor.length,
      averageScore: Math.round(average(motor.map((item) => item.score))),
      averageKilograms: average(motor.map((item) => item.metrics.averageKilograms)),
      averagePeakKilograms: average(motor.map((item) => item.metrics.peakKilograms)),
      averageContinuousHoldMs: average(motor.map((item) => item.metrics.continuousHoldMs)),
    },
    goNoGo: {
      sessions: attention.length,
      averageScore: Math.round(average(attention.map((item) => item.score))),
      averageAccuracyPercent: average(attention.map((item) => item.metrics.accuracyPercent)),
      averageReactionMs: average(attention.flatMap((item) => item.metrics.meanHitReactionMs === null ? [] : [item.metrics.meanHitReactionMs])),
    },
    sequenceMemory: {
      sessions: memory.length,
      averageScore: Math.round(average(memory.map((item) => item.score))),
      averageMaxSequenceLength: average(memory.map((item) => item.metrics.maxSequenceLength)),
      averageFirstResponseMs: average(memory.flatMap((item) => item.metrics.meanFirstResponseMs === null ? [] : [item.metrics.meanFirstResponseMs])),
    },
  };
  return { aggregate };
}

export async function upsertParticipantSummary(
  tx: Prisma.TransactionClient,
  participantId: string,
  institutionId: string,
): Promise<void> {
  const results = await tx.trGameResult.findMany({
    where: { participantId, institutionId },
    select: { score: true, metrics: true },
  });
  const summary = buildParticipantAggregate(results);
  await tx.trParticipantSummary.upsert({
    where: { participantId },
    create: {
      participantId,
      institutionId,
      savedSessionsTotal: summary.aggregate.sessions,
      aggregateMetrics: summary.aggregate,
      participantSummary: '',
      clinicianSummary: '',
      source: 'PENDING',
    },
    update: {
      savedSessionsTotal: summary.aggregate.sessions,
      aggregateMetrics: summary.aggregate,
      participantSummary: '',
      clinicianSummary: '',
      source: 'PENDING',
    },
  });
}
