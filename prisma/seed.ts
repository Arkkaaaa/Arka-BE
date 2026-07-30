import 'dotenv/config';
import { isDeepStrictEqual } from 'node:util';
import { GameMode, Prisma } from '../src/generated/prisma/client.js';
import { createPrisma } from '../src/db/prisma.js';

const VERSION = 'mvp-1.0.0' as const;
const OWNER_PRESENCE_GRACE_MS = 30_000;

const rules = [
  {
    mode: GameMode.MOTOR_GRIP,
    version: VERSION,
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
    version: VERSION,
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
    version: VERSION,
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

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL is required to seed game rules.');

const prisma = createPrisma(databaseUrl);
const maximumAttempts = 5;

async function seed(): Promise<number> {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const institutions = await transaction.institution.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true },
          });
          const approvedAt = new Date();

          for (const institution of institutions) {
            for (const rule of rules) {
              const identity = {
                institutionId: institution.id,
                mode: rule.mode,
                version: rule.version,
              };
              const existing = await transaction.gameRuleVersion.findUnique({
                where: { institutionId_mode_version: identity },
              });

              if (existing && !isDeepStrictEqual(existing.config, rule.config)) {
                throw new Error(
                  `Immutable game rule version collision for ${institution.id}/${rule.mode}/${rule.version}.`,
                );
              }

              await transaction.gameRuleVersion.updateMany({
                where: {
                  institutionId: institution.id,
                  mode: rule.mode,
                  isActive: true,
                  version: { not: rule.version },
                },
                data: { isActive: false },
              });

              if (existing) {
                await transaction.gameRuleVersion.update({
                  where: { id: existing.id },
                  data: {
                    isActive: true,
                    ...(existing.approvedAt ? {} : { approvedAt }),
                  },
                });
              } else {
                await transaction.gameRuleVersion.create({
                  data: {
                    ...identity,
                    config: rule.config,
                    isActive: true,
                    approvedAt,
                  },
                });
              }
            }
          }

          return institutions.length;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < maximumAttempts
      )
        continue;
      throw error;
    }
  }

  throw new Error('Unable to seed game rules after transaction retries.');
}

try {
  const institutionCount = await seed();
  console.log(
    `Seeded ${rules.length} active game rules for ${institutionCount} active institutions.`,
  );
} finally {
  await prisma.$disconnect();
}
