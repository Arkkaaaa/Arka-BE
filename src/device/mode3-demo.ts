import type { PrismaClient } from '../generated/prisma/client.js';

export const MODE3_DEMO_HOST_KEY = '00000000-0000-4000-8000-000000000003';
export const MODE3_DEMO_RULE_VERSION = 'sequence-v2';
export const MODE3_SINGLETON_KEY = 'singleton';

export async function ensureMode3Rule(prisma: PrismaClient): Promise<void> {
  const config = {
    initialSequenceLength: 2,
    maxSequenceLength: 6,
    initialLives: 2,
    exampleItemMs: 700,
    exampleGapMs: 500,
    responseTimeoutMs: 10_000,
    feedbackMs: 750,
    ownerPresenceGraceMs: 30_000,
  };
  await prisma.$transaction(async (transaction) => {
    await transaction.institution.upsert({
      where: { id: MODE3_DEMO_HOST_KEY },
      create: { id: MODE3_DEMO_HOST_KEY, name: 'Arka Mode 3 Demo Host' },
      update: { status: 'ACTIVE' },
    });
    const existing = await transaction.gameRuleVersion.findUnique({
      where: {
        institutionId_mode_version: {
          institutionId: MODE3_DEMO_HOST_KEY,
          mode: 'SEQUENCE_MEMORY',
          version: MODE3_DEMO_RULE_VERSION,
        },
      },
    });
    if (!existing) {
      await transaction.gameRuleVersion.create({
        data: {
          institutionId: MODE3_DEMO_HOST_KEY,
          mode: 'SEQUENCE_MEMORY',
          version: MODE3_DEMO_RULE_VERSION,
          config,
          isActive: true,
          approvedAt: new Date(),
        },
      });
      return;
    }
    await transaction.gameRuleVersion.update({
      where: { id: existing.id },
      data: { isActive: true, approvedAt: existing.approvedAt ?? new Date() },
    });
  });
}
