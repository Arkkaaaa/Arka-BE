import { describe, expect, it } from 'vitest';
import {
  createMotorGrip,
  normalizeGrip,
  pauseMotorGrip,
  resumeMotorGrip,
  sampleMotorGrip,
  tickMotorGrip,
} from './motor-grip.js';
import {
  createGoNoGo,
  generateGoNoGoPlan,
  pauseGoNoGo,
  pressGoNoGo,
  resumeGoNoGo,
  tickGoNoGo,
} from './go-no-go.js';
import {
  createSequenceMemory,
  generateMemorySequence,
  inputSequenceMemory,
  tickSequenceMemory,
} from './sequence-memory.js';
import { calibrateGoNoGo, classifyFsrEdge } from './setup.js';

const motorConfig = {
  baselineRaw: 100,
  calibratedMaxRaw: 1_100,
  sustainThreshold: 50,
  targetHoldMs: 5_000,
  sessionDurationMs: 10_000,
  telemetryGapMs: 300,
} as const;

const attentionConfig = {
  totalTrials: 40,
  trialDurationMs: 3_000,
  targetPercent: 35,
} as const;

const memoryConfig = {
  initialSequenceLength: 2,
  maxCompletedLevels: 1,
  initialLives: 2,
  exampleItemMs: 100,
  exampleGapMs: 0,
  responseTimeoutMs: 500,
  feedbackMs: 0,
} as const;

describe('motor grip engine', () => {
  it('normalizes calibrated FSR samples and clamps the result', () => {
    expect(normalizeGrip(0, motorConfig)).toBe(0);
    expect(normalizeGrip(600, motorConfig)).toBe(50);
    expect(normalizeGrip(4_095, motorConfig)).toBe(100);
  });

  it('resets the current hold immediately below threshold while preserving the longest hold', () => {
    let state = createMotorGrip(motorConfig, 0);
    state = sampleMotorGrip(state, 700, 0).state;
    for (let nowMs = 100; nowMs <= 1_000; nowMs += 100) {
      state = sampleMotorGrip(state, 700, nowMs).state;
    }

    state = sampleMotorGrip(state, 100, 1_000).state;

    expect(state).toMatchObject({
      currentHoldMs: 0,
      longestHoldMs: 1_000,
    });
    expect(sampleMotorGrip(state, 700, 1_150).state).toMatchObject({
      currentHoldMs: 0,
      longestHoldMs: 1_000,
    });
  });

  it('does not count paused time and requires a new hold after resume', () => {
    let state = createMotorGrip(motorConfig, 0);
    state = sampleMotorGrip(state, 700, 0).state;
    state = tickMotorGrip(state, 1_000).state;
    state = pauseMotorGrip(state, 1_000).state;
    state = resumeMotorGrip(state, 5_000).state;

    expect(tickMotorGrip(state, 6_000).state).toMatchObject({
      activeElapsedMs: 2_000,
      currentHoldMs: 0,
    });
  });
});

describe('Go/No-Go engine', () => {
  it('generates a deterministic constrained target distribution', () => {
    const plan = generateGoNoGoPlan(42, attentionConfig);
    expect(plan).toEqual(generateGoNoGoPlan(42, attentionConfig));
    expect(plan.filter((trial) => trial.isTarget)).toHaveLength(14);

    let runLength = 0;
    let previous: boolean | undefined;
    for (const trial of plan) {
      runLength = trial.isTarget === previous ? runLength + 1 : 1;
      expect(runLength).toBeLessThanOrEqual(trial.isTarget ? 3 : 4);
      previous = trial.isTarget;
    }
  });

  it('accepts only the first press in a stimulus window', () => {
    let state = createGoNoGo(attentionConfig, 7, 0);
    const first = pressGoNoGo(state, 100);
    const duplicate = pressGoNoGo(first.state, 200);
    state = tickGoNoGo(duplicate.state, 3_000).state;

    expect(first.acceptedPress).toBe(true);
    expect(duplicate.acceptedPress).toBe(false);
    expect(state.trials[0]).toMatchObject({ reactionMs: 100, duplicatePresses: 1 });
  });

  it('preserves the response deadline across pause and resume', () => {
    let state = createGoNoGo(attentionConfig, 9, 0);
    state = pauseGoNoGo(state, 400).state;
    state = resumeGoNoGo(state, 5_000).state;
    const press = pressGoNoGo(state, 5_100);

    expect(state.responseClosesAtMs).toBe(7_600);
    expect(tickGoNoGo(press.state, 7_600).state.trials[0]?.reactionMs).toBe(500);
  });
});

describe('sequence memory engine', () => {
  it('generates deterministic sequences without three equal items in a row', () => {
    const sequence = generateMemorySequence(123, 64);
    expect(sequence).toEqual(generateMemorySequence(123, 64));
    for (let index = 2; index < sequence.length; index += 1) {
      expect(new Set(sequence.slice(index - 2, index + 1)).size).toBeGreaterThan(1);
    }
  });

  it('completes a level from the exact physical-button sequence', () => {
    let state = createSequenceMemory(memoryConfig, 21, 0);
    state = tickSequenceMemory(state, 200).state;
    const first = inputSequenceMemory(state, state.sequence[0]!, 250);
    const second = inputSequenceMemory(first.state, state.sequence[1]!, 300);

    expect(first.acceptedInput).toBe(true);
    expect(second.completed?.metrics).toMatchObject({
      maxSequenceLength: 2,
      completedLevels: 1,
      completionReason: 'LEVEL_CAP_REACHED',
    });
    expect(second.completed?.trials[0]).toMatchObject({
      outcome: 'SUCCESS',
      firstResponseMs: 50,
      interButtonMs: [50],
    });
  });

  it('treats simultaneous physical buttons as one failed attempt', () => {
    let state = createSequenceMemory({ ...memoryConfig, initialLives: 1 }, 21, 0);
    state = tickSequenceMemory(state, 200).state;
    const failed = inputSequenceMemory(state, 'MULTIPLE', 250);

    expect(failed.acceptedInput).toBe(true);
    expect(failed.completed?.metrics).toMatchObject({
      wrongAttempts: 1,
      multiButtonAttempts: 1,
      completionReason: 'LIVES_EXHAUSTED',
    });
  });
});

describe('setup calibration', () => {
  it('derives separated hysteresis thresholds and rearms only after release', () => {
    const calibration = calibrateGoNoGo([100, 100, 100], [500, 500, 500], {
      releaseMinimumSamples: 3,
      pressMinimumSamples: 3,
      minimumDeltaRaw: 200,
      pressPercentile: 0.5,
      pressThresholdFraction: 0.4,
      releaseThresholdFraction: 0.2,
    });
    expect(calibration).toMatchObject({
      valid: true,
      baselineRaw: 100,
      pressedRaw: 500,
      pressThreshold: 260,
      releaseThreshold: 180,
    });

    const pressed = classifyFsrEdge({ pressed: false, armed: true }, 260, 260, 180);
    const held = classifyFsrEdge(pressed.state, 200, 260, 180);
    const released = classifyFsrEdge(held.state, 179, 260, 180);
    const pressedAgain = classifyFsrEdge(released.state, 260, 260, 180);

    expect(pressed.edge).toBe('PRESS');
    expect(held).toMatchObject({ edge: null, instruction: 'RELEASE' });
    expect(released.edge).toBe('RELEASE');
    expect(pressedAgain.edge).toBe('PRESS');
  });
});
