import { isDeepStrictEqual } from 'node:util';
import { GameMode, Prisma, type PrismaClient } from '../generated/prisma/client.js';

export const GAME_RULE_VERSION = 'mvp-1.0.0';
const OWNER_PRESENCE_GRACE_MS = 30_000;

export const GAME_RULES = [
  {
    mode: GameMode.MOTOR_GRIP,
    version: GAME_RULE_VERSION,
    config: {
      baselineMinimumSamples: 10,
      activeMinimumSamples: 20,
      minimumDeltaRaw: 200,
      calibratedPercentile: 0.9,
      sustainThreshold: 30,
      targetHoldMs: 5_000,
      sessionDurationMs: 30_000,
      telemetryGapMs: 300,
      ownerPresenceGraceMs: OWNER_PRESENCE_GRACE_MS,
      score: {
        maximum: 1_000,
        targetCompletedPoints: 500,
        continuousHoldPoints: 300,
        peakGripPercentMultiplier: 2,
      },
      feedback: { audioIntensity: 'LOW', haptic: 'PULSED_LIGHT', led: 'GREEN' },
    },
  },
  {
    mode: GameMode.GO_NO_GO,
    version: GAME_RULE_VERSION,
    config: {
      releaseMinimumSamples: 10,
      pressMinimumSamples: 10,
      minimumDeltaRaw: 200,
      pressPercentile: 0.5,
      pressThresholdFraction: 0.4,
      releaseThresholdFraction: 0.2,
      totalTrials: 40,
      targetTrials: 14,
      targetPercent: 35,
      trialDurationMs: 3_000,
      maxConsecutiveTargets: 3,
      maxConsecutiveNonTargets: 4,
      ownerPresenceGraceMs: OWNER_PRESENCE_GRACE_MS,
      score: { maximum: 1_000, accuracyPercentMultiplier: 10 },
      feedback: { audioIntensity: 'LOW' },
    },
  },
  {
    mode: GameMode.SEQUENCE_MEMORY,
    version: GAME_RULE_VERSION,
    config: {
      initialSequenceLength: 2,
      maxSequenceLength: 6,
      initialLives: 2,
      exampleItemMs: 700,
      exampleGapMs: 500,
      responseTimeoutMs: 10_000,
      feedbackMs: 750,
      ownerPresenceGraceMs: OWNER_PRESENCE_GRACE_MS,
      disallowThreeIdenticalInSequence: true,
      score: {
        maximum: 1_000,
        sequenceLengthMultiplier: 125,
        completedLevelMultiplier: 20,
        wrongAttemptPenalty: 50,
        timedOutAttemptPenalty: 25,
      },
      feedback: { audioIntensity: 'LOW' },
    },
  },
] as const satisfies ReadonlyArray<{
  mode: (typeof GameMode)[keyof typeof GameMode];
  version: string;
  config: Prisma.InputJsonObject;
}>;

async function ensureRules(
  transaction: Prisma.TransactionClient,
  institutionId: string,
): Promise<void> {
  for (const rule of GAME_RULES) {
    const identity = { institutionId, mode: rule.mode, version: rule.version };
    const existing = await transaction.gameRuleVersion.findUnique({
      where: { institutionId_mode_version: identity },
    });
    if (existing && !isDeepStrictEqual(existing.config, rule.config)) {
      throw new Error(`Immutable game rule version collision for ${institutionId}/${rule.mode}/${rule.version}.`);
    }
    await transaction.gameRuleVersion.updateMany({
      where: {
        institutionId,
        mode: rule.mode,
        isActive: true,
        version: { not: rule.version },
      },
      data: { isActive: false },
    });
    if (existing) {
      await transaction.gameRuleVersion.update({
        where: { id: existing.id },
        data: { isActive: true, approvedAt: existing.approvedAt ?? new Date() },
      });
    } else {
      await transaction.gameRuleVersion.create({
        data: {
          ...identity,
          config: rule.config,
          isActive: true,
          approvedAt: new Date(),
        },
      });
    }
  }
}

export async function ensureInstitutionGameRules(
  prisma: PrismaClient,
  institutionId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const institution = await transaction.institution.findFirst({
      where: { id: institutionId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!institution) throw new Error(`Active institution not found: ${institutionId}`);
    await ensureRules(transaction, institution.id);
  });
}

export async function ensureAllInstitutionGameRules(prisma: PrismaClient): Promise<number> {
  return prisma.$transaction(
    async (transaction) => {
      const institutions = await transaction.institution.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
      for (const institution of institutions) await ensureRules(transaction, institution.id);
      return institutions.length;
    },
    { isolationLevel: 'Serializable' },
  );
}
