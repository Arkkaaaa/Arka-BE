import type { EngineCompletion } from './types.js';
import { assertMonotonic, clamp, mean } from './types.js';

export const GO_NO_GO_STIMULI = ['WAYANG', 'BATIK', 'CANDI', 'MONAS', 'ANGKLUNG'] as const;
export type GoNoGoStimulus = (typeof GO_NO_GO_STIMULI)[number];
export type GoNoGoOutcome = 'HIT' | 'MISS' | 'FALSE_POSITIVE' | 'CORRECT_REJECTION';

export interface GoNoGoLevelConfig {
  level: 1 | 2;
  stimulusDurationMs: number;
  totalTrials?: number;
}

export interface GoNoGoConfig {
  targetPreviewDurationMs: number;
  initialCueDurationMs: number;
  scoredDurationMs: number;
  targetPercent: number;
  levels: readonly [GoNoGoLevelConfig, GoNoGoLevelConfig];
}

export interface GoNoGoTrialPlan {
  readonly index: number;
  readonly level: 1 | 2;
  readonly levelTrialNumber: number;
  readonly stimulusDurationMs: number;
  readonly stimulus: GoNoGoStimulus;
  readonly assetIndex: number;
  readonly isTarget: boolean;
}

export interface GoNoGoTrialResult extends GoNoGoTrialPlan {
  readonly outcome: GoNoGoOutcome;
  readonly reactionMs: number | null;
  readonly duplicatePresses: number;
  readonly stimulusStartedAtMs: number;
  readonly responseClosedAtMs: number;
}

export interface GoNoGoLevelMetrics {
  level: number;
  stimulusDurationMs: number;
  totalTrials: number;
  hits: number;
  misses: number;
  falsePositives: number;
  correctRejections: number;
  accuracyPercent: number;
  meanHitReactionMs: number | null;
}

export interface GoNoGoMetrics {
  mode: 'GO_NO_GO';
  totalTrials: number;
  targetTrials: number;
  nonTargetTrials: number;
  hits: number;
  misses: number;
  falsePositives: number;
  correctRejections: number;
  accuracyPercent: number;
  meanHitReactionMs: number | null;
  levelBreakdown: GoNoGoLevelMetrics[];
}

export interface GoNoGoState {
  readonly mode: 'GO_NO_GO';
  readonly lifecycle: 'PLAYING' | 'PAUSED' | 'COMPLETED';
  readonly config: GoNoGoConfig;
  readonly plan: readonly GoNoGoTrialPlan[];
  readonly currentTrialIndex: number;
  readonly targetPreviewEndsAtMs: number;
  readonly trialStartedAtMs: number;
  readonly responseClosesAtMs: number;
  readonly firstPressAtMs: number | null;
  readonly duplicatePresses: number;
  readonly outOfWindowPresses: number;
  readonly lastNowMs: number;
  readonly pauseRemainingMs: number | null;
  readonly pauseTrialStartsInMs: number | null;
  readonly pauseTargetPreviewEndsInMs: number | null;
  readonly trials: readonly GoNoGoTrialResult[];
  readonly completion: EngineCompletion<GoNoGoMetrics, GoNoGoTrialResult> | null;
}

export interface GoNoGoTransition {
  readonly state: GoNoGoState;
  readonly acceptedPress: boolean;
  readonly visual: {
    mode: 'GO_NO_GO';
    trialNumber: number;
    level: 1 | 2;
    levelTrialNumber: number;
    levelTrialCount: number;
    totalLevels: 2;
    stimulus: GoNoGoStimulus | null;
    assetIndex: number | null;
    phase: 'TARGET_PREVIEW' | 'TURN_CUE' | 'STIMULUS' | 'FEEDBACK';
    activeElapsedMs: number;
    remainingMs: number;
    feedback: 'CORRECT' | 'MISS' | 'FALSE_POSITIVE' | 'WAIT' | null;
    correctTrials: number;
  };
  readonly completed: EngineCompletion<GoNoGoMetrics, GoNoGoTrialResult> | null;
}

interface ExactAsset {
  readonly stimulus: GoNoGoStimulus;
  readonly assetIndex: number;
}

const NON_TARGET_ASSETS: readonly ExactAsset[] = [
  { stimulus: 'WAYANG', assetIndex: 1 },
  { stimulus: 'WAYANG', assetIndex: 2 },
  { stimulus: 'WAYANG', assetIndex: 3 },
  { stimulus: 'BATIK', assetIndex: 0 },
  { stimulus: 'BATIK', assetIndex: 1 },
  { stimulus: 'BATIK', assetIndex: 2 },
  { stimulus: 'BATIK', assetIndex: 3 },
  { stimulus: 'CANDI', assetIndex: 0 },
  { stimulus: 'CANDI', assetIndex: 1 },
  { stimulus: 'CANDI', assetIndex: 2 },
  { stimulus: 'CANDI', assetIndex: 3 },
  { stimulus: 'MONAS', assetIndex: 0 },
  { stimulus: 'MONAS', assetIndex: 1 },
  { stimulus: 'MONAS', assetIndex: 2 },
  { stimulus: 'MONAS', assetIndex: 3 },
  { stimulus: 'ANGKLUNG', assetIndex: 0 },
  { stimulus: 'ANGKLUNG', assetIndex: 1 },
  { stimulus: 'ANGKLUNG', assetIndex: 2 },
  { stimulus: 'ANGKLUNG', assetIndex: 3 },
];

function nextRandom(state: number): readonly [number, number] {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  const next = value >>> 0 || 0x9e3779b9;
  return [next / 0x1_0000_0000, next];
}

function validateConfig(config: GoNoGoConfig): void {
  const [level1, level2] = config.levels;
  const valid =
    config.targetPreviewDurationMs === 3_000 &&
    config.initialCueDurationMs === 2_500 &&
    config.scoredDurationMs === 180_000 &&
    config.targetPercent === 35 &&
    level1.level === 1 &&
    level1.stimulusDurationMs === 3_000 &&
    level1.totalTrials === 5 &&
    level2.level === 2 &&
    level2.stimulusDurationMs === 2_000 &&
    level2.totalTrials === undefined;
  if (!valid) throw new RangeError('Invalid Go/No-Go rule configuration');
}

function trialDurations(config: GoNoGoConfig): readonly { level: 1 | 2; durationMs: number }[] {
  const [level1, level2] = config.levels;
  const durations: { level: 1 | 2; durationMs: number }[] = Array.from({ length: level1.totalTrials! }, () => ({
    level: 1,
    durationMs: level1.stimulusDurationMs,
  }));
  let remainingMs = config.scoredDurationMs - level1.totalTrials! * level1.stimulusDurationMs;
  while (remainingMs > 0) {
    const durationMs = Math.min(level2.stimulusDurationMs, remainingMs);
    durations.push({ level: 2, durationMs });
    remainingMs -= durationMs;
  }
  return durations;
}

function targetSequence(totalTrials: number, targetPercent: number, seed: number): readonly [boolean[], number] {
  let cursor = seed >>> 0 || 0x9e3779b9;
  let targetsRemaining = Math.round(totalTrials * targetPercent / 100);
  let nonTargetsRemaining = totalTrials - targetsRemaining;
  let previousTarget = false;
  let nonTargetRun = 0;
  const sequence: boolean[] = [];
  while (targetsRemaining + nonTargetsRemaining > 0) {
    const remainingAfterChoice = targetsRemaining + nonTargetsRemaining - 1;
    const mustTarget = targetsRemaining > Math.ceil(remainingAfterChoice / 2) || nonTargetRun >= 4;
    const canTarget: boolean = !previousTarget && targetsRemaining > 0;
    const [random, next] = nextRandom(cursor);
    cursor = next;
    const chooseTarget: boolean = canTarget && (mustTarget || nonTargetsRemaining === 0 || random < targetsRemaining / (targetsRemaining + nonTargetsRemaining));
    sequence.push(chooseTarget);
    if (chooseTarget) {
      targetsRemaining -= 1;
      nonTargetRun = 0;
    } else {
      nonTargetsRemaining -= 1;
      nonTargetRun += 1;
    }
    previousTarget = chooseTarget;
  }
  return [sequence, cursor];
}

function sameAsset(left: ExactAsset | undefined, right: ExactAsset): boolean {
  return left?.stimulus === right.stimulus && left.assetIndex === right.assetIndex;
}

export function generateGoNoGoPlan(seed: number, config: GoNoGoConfig): readonly GoNoGoTrialPlan[] {
  validateConfig(config);
  const durations = trialDurations(config);
  let [targets, cursor] = targetSequence(durations.length, config.targetPercent, seed);
  let previousAsset: ExactAsset | undefined;
  let levelTrialNumber = 0;
  let previousLevel: 1 | 2 | undefined;
  return durations.map(({ level, durationMs }, index) => {
    levelTrialNumber = level === previousLevel ? levelTrialNumber + 1 : 1;
    previousLevel = level;
    let asset: ExactAsset;
    if (targets[index]) {
      asset = { stimulus: 'WAYANG', assetIndex: 0 };
    } else {
      const candidates = NON_TARGET_ASSETS.filter((candidate) => !sameAsset(previousAsset, candidate));
      const [random, next] = nextRandom(cursor);
      cursor = next;
      asset = candidates[Math.floor(random * candidates.length)]!;
    }
    previousAsset = asset;
    return {
      index,
      level,
      levelTrialNumber,
      stimulusDurationMs: durationMs,
      stimulus: asset.stimulus,
      assetIndex: asset.assetIndex,
      isTarget: asset.stimulus === 'WAYANG' && asset.assetIndex === 0,
    };
  });
}

export function createGoNoGo(config: GoNoGoConfig, seed: number, nowMs: number): GoNoGoState {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Invalid monotonic timestamp');
  const plan = generateGoNoGoPlan(seed, config);
  const targetPreviewEndsAtMs = nowMs + config.targetPreviewDurationMs;
  const trialStartedAtMs = targetPreviewEndsAtMs + config.initialCueDurationMs;
  return {
    mode: 'GO_NO_GO',
    lifecycle: 'PLAYING',
    config: {
      ...config,
      levels: config.levels.map((level) => ({ ...level })) as [GoNoGoLevelConfig, GoNoGoLevelConfig],
    },
    plan,
    currentTrialIndex: 0,
    targetPreviewEndsAtMs,
    trialStartedAtMs,
    responseClosesAtMs: trialStartedAtMs + plan[0]!.stimulusDurationMs,
    firstPressAtMs: null,
    duplicatePresses: 0,
    outOfWindowPresses: 0,
    lastNowMs: nowMs,
    pauseRemainingMs: null,
    pauseTrialStartsInMs: null,
    pauseTargetPreviewEndsInMs: null,
    trials: [],
    completion: null,
  };
}

function outcomeFor(plan: GoNoGoTrialPlan, pressed: boolean): GoNoGoOutcome {
  if (plan.isTarget) return pressed ? 'HIT' : 'MISS';
  return pressed ? 'FALSE_POSITIVE' : 'CORRECT_REJECTION';
}

function metricsForTrials(trials: readonly GoNoGoTrialResult[]): Omit<GoNoGoLevelMetrics, 'level' | 'stimulusDurationMs'> {
  const hits = trials.filter((trial) => trial.outcome === 'HIT').length;
  const misses = trials.filter((trial) => trial.outcome === 'MISS').length;
  const falsePositives = trials.filter((trial) => trial.outcome === 'FALSE_POSITIVE').length;
  const correctRejections = trials.filter((trial) => trial.outcome === 'CORRECT_REJECTION').length;
  return {
    totalTrials: trials.length,
    hits,
    misses,
    falsePositives,
    correctRejections,
    accuracyPercent: trials.length === 0 ? 0 : ((hits + correctRejections) / trials.length) * 100,
    meanHitReactionMs: mean(
      trials.filter((trial) => trial.outcome === 'HIT').map((trial) => trial.reactionMs as number),
    ),
  };
}

function completionFor(
  trials: readonly GoNoGoTrialResult[],
  config: GoNoGoConfig,
): EngineCompletion<GoNoGoMetrics, GoNoGoTrialResult> {
  const aggregate = metricsForTrials(trials);
  const metrics: GoNoGoMetrics = {
    mode: 'GO_NO_GO',
    ...aggregate,
    targetTrials: aggregate.hits + aggregate.misses,
    nonTargetTrials: aggregate.falsePositives + aggregate.correctRejections,
    levelBreakdown: config.levels.map((level) => ({
      level: level.level,
      stimulusDurationMs: level.stimulusDurationMs,
      ...metricsForTrials(trials.filter((trial) => trial.level === level.level)),
    })),
  };
  return {
    lifecycle: 'COMPLETED',
    score: clamp(Math.round(metrics.accuracyPercent * 10), 0, 1000),
    metrics,
    trials,
  };
}

function closeCurrentTrial(state: GoNoGoState): GoNoGoState {
  const plan = state.plan[state.currentTrialIndex];
  if (!plan) return state;
  const pressed = state.firstPressAtMs !== null;
  const trial: GoNoGoTrialResult = {
    ...plan,
    outcome: outcomeFor(plan, pressed),
    reactionMs: state.firstPressAtMs === null ? null : state.firstPressAtMs - state.trialStartedAtMs,
    duplicatePresses: state.duplicatePresses,
    stimulusStartedAtMs: state.trialStartedAtMs,
    responseClosedAtMs: state.responseClosesAtMs,
  };
  const trials = [...state.trials, trial];
  if (trials.length >= state.plan.length) {
    return { ...state, lifecycle: 'COMPLETED', trials, completion: completionFor(trials, state.config) };
  }
  const nextPlan = state.plan[state.currentTrialIndex + 1]!;
  return {
    ...state,
    trials,
    currentTrialIndex: state.currentTrialIndex + 1,
    trialStartedAtMs: state.responseClosesAtMs,
    responseClosesAtMs: state.responseClosesAtMs + nextPlan.stimulusDurationMs,
    firstPressAtMs: null,
    duplicatePresses: 0,
  };
}

function advance(state: GoNoGoState, nowMs: number): GoNoGoState {
  assertMonotonic(nowMs, state.lastNowMs);
  let next = { ...state, lastNowMs: nowMs };
  if (next.lifecycle !== 'PLAYING') return next;
  while (next.lifecycle === 'PLAYING' && nowMs >= next.responseClosesAtMs) next = closeCurrentTrial(next);
  return next;
}

function transition(state: GoNoGoState, acceptedPress: boolean): GoNoGoTransition {
  const current = state.plan[state.currentTrialIndex] ?? state.plan.at(-1)!;
  const correctTrials = state.trials.filter(
    (trial) => trial.outcome === 'HIT' || trial.outcome === 'CORRECT_REJECTION',
  ).length;
  const last = state.trials.at(-1);
  const feedback =
    state.lifecycle === 'COMPLETED' && last
      ? last.outcome === 'HIT' || last.outcome === 'CORRECT_REJECTION'
        ? 'CORRECT'
        : last.outcome === 'MISS'
          ? 'MISS'
          : 'FALSE_POSITIVE'
      : state.firstPressAtMs !== null
        ? 'WAIT'
        : null;
  const scoredBeforeCurrentMs = state.trials.reduce((total, trial) => total + trial.stimulusDurationMs, 0);
  const currentElapsedMs = state.lifecycle === 'PAUSED'
    ? current.stimulusDurationMs - (state.pauseRemainingMs ?? current.stimulusDurationMs)
    : state.lastNowMs - state.trialStartedAtMs;
  const activeElapsedMs = clamp(
    scoredBeforeCurrentMs + (state.lifecycle === 'COMPLETED' ? 0 : clamp(currentElapsedMs, 0, current.stimulusDurationMs)),
    0,
    state.config.scoredDurationMs,
  );
  const targetPreviewActive = state.lifecycle !== 'COMPLETED' && (state.lifecycle === 'PAUSED'
    ? (state.pauseTargetPreviewEndsInMs ?? 0) > 0
    : state.lastNowMs < state.targetPreviewEndsAtMs);
  const cueActive = state.lifecycle !== 'COMPLETED' && !targetPreviewActive && (state.lifecycle === 'PAUSED'
    ? (state.pauseTrialStartsInMs ?? 0) > 0
    : state.lastNowMs < state.trialStartedAtMs);
  const phase = state.lifecycle === 'COMPLETED'
    ? 'FEEDBACK'
    : targetPreviewActive
      ? 'TARGET_PREVIEW'
      : cueActive
        ? 'TURN_CUE'
        : 'STIMULUS';
  const levelTrialCount = state.plan.filter((trial) => trial.level === current.level).length;
  return {
    state,
    acceptedPress,
    visual: {
      mode: 'GO_NO_GO',
      trialNumber: phase === 'TARGET_PREVIEW' || phase === 'TURN_CUE' ? 0 : Math.min(state.currentTrialIndex + 1, state.plan.length),
      level: current.level,
      levelTrialNumber: current.levelTrialNumber,
      levelTrialCount,
      totalLevels: 2,
      stimulus: phase === 'TARGET_PREVIEW' ? 'WAYANG' : phase === 'STIMULUS' ? current.stimulus : null,
      assetIndex: phase === 'TARGET_PREVIEW' ? 0 : phase === 'STIMULUS' ? current.assetIndex : null,
      phase,
      activeElapsedMs,
      remainingMs: Math.max(0, state.config.scoredDurationMs - activeElapsedMs),
      feedback,
      correctTrials,
    },
    completed: state.completion,
  };
}

export function pressGoNoGo(state: GoNoGoState, nowMs: number): GoNoGoTransition {
  let next = advance(state, nowMs);
  if (
    next.lifecycle !== 'PLAYING' ||
    nowMs < next.trialStartedAtMs ||
    nowMs >= next.responseClosesAtMs
  ) {
    if (next.lifecycle === 'PLAYING') next = { ...next, outOfWindowPresses: next.outOfWindowPresses + 1 };
    return transition(next, false);
  }
  if (next.firstPressAtMs !== null) {
    return transition({ ...next, duplicatePresses: next.duplicatePresses + 1 }, false);
  }
  return transition({ ...next, firstPressAtMs: nowMs }, true);
}

export function tickGoNoGo(state: GoNoGoState, nowMs: number): GoNoGoTransition {
  return transition(advance(state, nowMs), false);
}

export function pauseGoNoGo(state: GoNoGoState, nowMs: number): GoNoGoTransition {
  const next = advance(state, nowMs);
  if (next.lifecycle !== 'PLAYING') return transition(next, false);
  return transition(
    {
      ...next,
      lifecycle: 'PAUSED',
      pauseRemainingMs: next.responseClosesAtMs - nowMs,
      pauseTrialStartsInMs: next.trialStartedAtMs - nowMs,
      pauseTargetPreviewEndsInMs: next.targetPreviewEndsAtMs - nowMs,
    },
    false,
  );
}

export function resumeGoNoGo(state: GoNoGoState, nowMs: number): GoNoGoTransition {
  assertMonotonic(nowMs, state.lastNowMs);
  if (
    state.lifecycle !== 'PAUSED' ||
    state.pauseRemainingMs === null ||
    state.pauseTrialStartsInMs === null ||
    state.pauseTargetPreviewEndsInMs === null
  ) {
    return transition({ ...state, lastNowMs: nowMs }, false);
  }
  return transition(
    {
      ...state,
      lifecycle: 'PLAYING',
      lastNowMs: nowMs,
      targetPreviewEndsAtMs: nowMs + state.pauseTargetPreviewEndsInMs,
      trialStartedAtMs: nowMs + state.pauseTrialStartsInMs,
      responseClosesAtMs: nowMs + state.pauseRemainingMs,
      pauseRemainingMs: null,
      pauseTrialStartsInMs: null,
      pauseTargetPreviewEndsInMs: null,
    },
    false,
  );
}
