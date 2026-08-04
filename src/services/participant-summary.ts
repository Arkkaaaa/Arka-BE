import { GameMetricsSchema, type GameMetrics } from '../schemas/index.js';
import type { Prisma } from '../generated/prisma/client.js';

interface ResultInput {
  readonly score: number;
  readonly metrics: unknown;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function deterministicSessionSummary(metrics: GameMetrics, score: number) {
  if (metrics.mode === 'MOTOR_GRIP') {
    return {
      participant: {
        summaryText: `Skor ${score}. Beban puncak ${metrics.peakKilograms.toFixed(2)} kg dan beban rata-rata ${metrics.averageKilograms.toFixed(2)} kg.`,
        observations: [`Tahanan kontinu ${Number(metrics.continuousHoldMs / 1000).toFixed(1)} detik.`, `Waktu di atas target ${Number(metrics.timeAtOrAboveTargetMs / 1000).toFixed(1)} detik.`],
      },
      clinician: {
        summaryText: `Skor ${score}; beban puncak ${metrics.peakKilograms.toFixed(2)} kg; beban rata-rata ${metrics.averageKilograms.toFixed(2)} kg.`,
        observations: [`Tahanan kontinu ${metrics.continuousHoldMs} milidetik.`, `Waktu pada atau di atas target ${metrics.timeAtOrAboveTargetMs} milidetik.`],
      },
    };
  }
  if (metrics.mode === 'GO_NO_GO') {
    return {
      participant: {
        summaryText: `Skor ${score} dengan akurasi ${Math.round(metrics.accuracyPercent)}% dari ${metrics.totalTrials} gambar.`,
        observations: [`Respons tepat ${metrics.hits + metrics.correctRejections}.`, `Target terlewat ${metrics.misses} dan genggaman keliru ${metrics.falsePositives}.`],
      },
      clinician: {
        summaryText: `Skor ${score}; akurasi ${metrics.accuracyPercent.toFixed(1)}%; total percobaan ${metrics.totalTrials}.`,
        observations: [`Respons target tepat ${metrics.hits}; berhasil menahan respons ${metrics.correctRejections}.`, `Target terlewat ${metrics.misses}; respons keliru ${metrics.falsePositives}.`],
      },
    };
  }
  return {
    participant: {
      summaryText: `Skor ${score} dengan urutan terpanjang level ${metrics.maxSequenceLength}.`,
      observations: [`Level selesai ${metrics.completedLevels}.`, `Percobaan salah ${metrics.wrongAttempts} dan waktu habis ${metrics.timedOutAttempts}.`],
    },
    clinician: {
      summaryText: `Skor ${score}; panjang urutan maksimum ${metrics.maxSequenceLength}; level selesai ${metrics.completedLevels}.`,
      observations: [`Percobaan salah ${metrics.wrongAttempts}; percobaan kehabisan waktu ${metrics.timedOutAttempts}.`, `Rata-rata respons pertama ${metrics.meanFirstResponseMs === null ? 'tidak tercatat' : `${Math.round(metrics.meanFirstResponseMs)} milidetik`}.`],
    },
  };
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
  const participantSummary = `Dari ${aggregate.sessions} permainan: beban rata-rata Peras Buah ${aggregate.motorGrip.averageKilograms.toFixed(2)} kg, akurasi Go-No-Go ${aggregate.goNoGo.averageAccuracyPercent.toFixed(0)}%, dan level ingatan rata-rata ${aggregate.sequenceMemory.averageMaxSequenceLength.toFixed(1)}.`;
  const clinicianSummary = `Agregat ${aggregate.sessions} sesi; beban rata-rata Peras Buah ${aggregate.motorGrip.averageKilograms.toFixed(2)} kg dan beban puncak ${aggregate.motorGrip.averagePeakKilograms.toFixed(2)} kg; akurasi Go-No-Go ${aggregate.goNoGo.averageAccuracyPercent.toFixed(1)}%; rentang urutan ${aggregate.sequenceMemory.averageMaxSequenceLength.toFixed(1)}.`;
  return { aggregate, participantSummary, clinicianSummary };
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
      participantSummary: summary.participantSummary,
      clinicianSummary: summary.clinicianSummary,
    },
    update: {
      savedSessionsTotal: summary.aggregate.sessions,
      aggregateMetrics: summary.aggregate,
      participantSummary: summary.participantSummary,
      clinicianSummary: summary.clinicianSummary,
      source: 'DETERMINISTIC',
    },
  });
}
