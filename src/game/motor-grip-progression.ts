import { z } from 'zod';
import { FruitVariantSchema, type FruitVariant } from '../schemas/common.js';

export const MOTOR_GRIP_FRUITS = [
  'STRAWBERRY',
  'TOMATO',
  'BANANA',
  'ORANGE',
  'APPLE',
  'WATERMELON',
] as const satisfies readonly FruitVariant[];

export const MotorGripTargetsSchema = z.object({
  fruitTargetsKilograms: z.record(FruitVariantSchema, z.number().positive().max(120)),
}).passthrough();

const ProgressionMetricsSchema = z.object({
  mode: z.literal('MOTOR_GRIP'),
  fruitVariant: FruitVariantSchema,
  targetCompleted: z.boolean(),
}).passthrough();

export interface MotorGripProgressionEvent {
  readonly sessionId: string;
  readonly completedAt: Date;
  readonly fruitVariant: FruitVariant;
  readonly targetCompleted: boolean;
}

export interface MotorGripProgression {
  readonly fruitVariant: FruitVariant;
  readonly level: number;
  readonly levelsTotal: 6;
  readonly completedSessions: number;
  readonly targetCompleted: number;
  readonly targetFailed: number;
}

export function progressionEvent(input: {
  readonly sessionId: string;
  readonly completedAt: Date;
  readonly metrics: unknown;
}): MotorGripProgressionEvent | null {
  const parsed = ProgressionMetricsSchema.safeParse(input.metrics);
  return parsed.success
    ? {
        sessionId: input.sessionId,
        completedAt: input.completedAt,
        fruitVariant: parsed.data.fruitVariant,
        targetCompleted: parsed.data.targetCompleted,
      }
    : null;
}

export function replayMotorGripProgression(
  events: readonly MotorGripProgressionEvent[],
): MotorGripProgression {
  const ordered = [...events].sort(
    (left, right) => left.completedAt.getTime() - right.completedAt.getTime() || left.sessionId.localeCompare(right.sessionId),
  );
  let levelIndex = 0;
  let completedSessions = 0;
  let targetCompleted = 0;

  for (const event of ordered) {
    if (event.fruitVariant !== MOTOR_GRIP_FRUITS[levelIndex]) continue;
    completedSessions += 1;
    if (event.targetCompleted) targetCompleted += 1;
    if (completedSessions < 3) continue;
    const delta = targetCompleted >= 2 ? 1 : -1;
    levelIndex = Math.max(0, Math.min(MOTOR_GRIP_FRUITS.length - 1, levelIndex + delta));
    completedSessions = 0;
    targetCompleted = 0;
  }

  return {
    fruitVariant: MOTOR_GRIP_FRUITS[levelIndex]!,
    level: levelIndex + 1,
    levelsTotal: 6,
    completedSessions,
    targetCompleted,
    targetFailed: completedSessions - targetCompleted,
  };
}
