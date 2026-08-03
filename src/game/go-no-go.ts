import type { EngineCompletion } from './types.js';
import { assertMonotonic, clamp, mean } from './types.js';

export const GO_NO_GO_STIMULI = ['WAYANG', 'BATIK', 'CANDI', 'MONAS', 'ANGKLUNG'] as const;
export type GoNoGoStimulus = (typeof GO_NO_GO_STIMULI)[number];
export type GoNoGoOutcome = 'HIT' | 'MISS' | 'FALSE_POSITIVE' | 'CORRECT_REJECTION';

export interface GoNoGoConfig {
  totalTrials: number;
  trialDurationMs: number;
  targetPercent: number;
}

export interface GoNoGoTrialPlan {
  readonly index: number;
  readonly stimulus: GoNoGoStimulus;
  readonly isTarget: boolean;
}

export interface GoNoGoTrialResult extends GoNoGoTrialPlan {
  readonly outcome: GoNoGoOutcome;
  readonly reactionMs: number | null;
  readonly duplicatePresses: number;
  readonly stimulusStartedAtMs: number;
  readonly responseClosedAtMs: number;
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
}

export interface GoNoGoState {
  readonly mode: 'GO_NO_GO';
  readonly lifecycle: 'PLAYING' | 'PAUSED' | 'COMPLETED';
  readonly config: GoNoGoConfig;
  readonly plan: readonly GoNoGoTrialPlan[];
  readonly currentTrialIndex: number;
  readonly trialStartedAtMs: number;
  readonly responseClosesAtMs: number;
  readonly firstPressAtMs: number | null;
  readonly duplicatePresses: number;
  readonly outOfWindowPresses: number;
  readonly lastNowMs: number;
  readonly pauseRemainingMs: number | null;
  readonly trials: readonly GoNoGoTrialResult[];
  readonly completion: EngineCompletion<GoNoGoMetrics, GoNoGoTrialResult> | null;
}

export interface GoNoGoTransition {
  readonly state: GoNoGoState;
  readonly acceptedPress: boolean;
  readonly visual: {
    mode: 'GO_NO_GO';
    trialNumber: number;
    stimulus: GoNoGoStimulus | null;
    phase: 'STIMULUS' | 'FEEDBACK';
    activeElapsedMs: number;
    remainingMs: number;
    feedback: 'CORRECT' | 'MISS' | 'FALSE_POSITIVE' | 'WAIT' | null;
    correctTrials: number;
  };
  readonly completed: EngineCompletion<GoNoGoMetrics, GoNoGoTrialResult> | null;
}

function nextRandom(state: number): readonly [number, number] {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  const next = value >>> 0 || 0x9e3779b9;
  return [next / 0x1_0000_0000, next];
}

function shuffled<T>(values: readonly T[], seed: number): readonly [T[], number] {
  const result = [...values];
  let cursor = seed >>> 0 || 0x9e3779b9;
  for (let index = result.length - 1; index > 0; index -= 1) {
    const [random, next] = nextRandom(cursor);
    cursor = next;
    const target = Math.floor(random * (index + 1));
    [result[index], result[target]] = [result[target] as T, result[index] as T];
  }
  return [result, cursor];
}

function validRun(sequence: readonly boolean[]): boolean {
  let run = 0;
  let previous: boolean | undefined;
  for (const item of sequence) {
    run = item === previous ? run + 1 : 1;
    if ((item && run > 3) || (!item && run > 4)) return false;
    previous = item;
  }
  return true;
}

export function generateGoNoGoPlan(seed: number, config: GoNoGoConfig): readonly GoNoGoTrialPlan[] {
  if (
    config.totalTrials !== 40 ||
    config.trialDurationMs !== 3_000 ||
    config.targetPercent !== 35
  ) {
    throw new RangeError('Go/No-Go MVP rules require 40 trials, 3000ms windows, and 35% targets');
  }
  const targetCount = 14;
  const base = [
    ...Array<boolean>(targetCount).fill(true),
    ...Array<boolean>(config.totalTrials - targetCount).fill(false),
  ];
  let cursor = seed >>> 0 || 0x9e3779b9;
  let sequence: boolean[] | null = null;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const [candidate, next] = shuffled(base, cursor);
    cursor = next;
    if (validRun(candidate)) {
      sequence = candidate;
      break;
    }
  }
  if (!sequence) throw new Error('Unable to generate a constrained Go/No-Go sequence');

  return sequence.map((isTarget, index) => {
    if (isTarget) return { index, stimulus: 'WAYANG', isTarget: true };
    const [random, next] = nextRandom(cursor);
    cursor = next;
    return {
      index,
      stimulus: GO_NO_GO_STIMULI[1 + Math.floor(random * 4)] as GoNoGoStimulus,
      isTarget: false,
    };
  });
}

export function createGoNoGo(config: GoNoGoConfig, seed: number, nowMs: number): GoNoGoState {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new RangeError('Invalid monotonic timestamp');
  const plan = generateGoNoGoPlan(seed, config);
  return {
    mode: 'GO_NO_GO',
    lifecycle: 'PLAYING',
    config: { ...config },
    plan,
    currentTrialIndex: 0,
    trialStartedAtMs: nowMs,
    responseClosesAtMs: nowMs + config.trialDurationMs,
    firstPressAtMs: null,
    duplicatePresses: 0,
    outOfWindowPresses: 0,
    lastNowMs: nowMs,
    pauseRemainingMs: null,
    trials: [],
    completion: null,
  };
}

function outcomeFor(plan: GoNoGoTrialPlan, pressed: boolean): GoNoGoOutcome {
  if (plan.isTarget) return pressed ? 'HIT' : 'MISS';
  return pressed ? 'FALSE_POSITIVE' : 'CORRECT_REJECTION';
}

function completionFor(
  trials: readonly GoNoGoTrialResult[],
): EngineCompletion<GoNoGoMetrics, GoNoGoTrialResult> {
  const hits = trials.filter((trial) => trial.outcome === 'HIT').length;
  const misses = trials.filter((trial) => trial.outcome === 'MISS').length;
  const falsePositives = trials.filter((trial) => trial.outcome === 'FALSE_POSITIVE').length;
  const correctRejections = trials.filter((trial) => trial.outcome === 'CORRECT_REJECTION').length;
  const metrics: GoNoGoMetrics = {
    mode: 'GO_NO_GO',
    totalTrials: trials.length,
    targetTrials: hits + misses,
    nonTargetTrials: falsePositives + correctRejections,
    hits,
    misses,
    falsePositives,
    correctRejections,
    accuracyPercent: trials.length === 0 ? 0 : ((hits + correctRejections) / trials.length) * 100,
    meanHitReactionMs: mean(
      trials.filter((trial) => trial.outcome === 'HIT').map((trial) => trial.reactionMs as number),
    ),
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
    reactionMs:
      state.firstPressAtMs === null ? null : state.firstPressAtMs - state.trialStartedAtMs,
    duplicatePresses: state.duplicatePresses,
    stimulusStartedAtMs: state.trialStartedAtMs,
    responseClosedAtMs: state.responseClosesAtMs,
  };
  const trials = [...state.trials, trial];
  if (trials.length >= state.plan.length) {
    return { ...state, lifecycle: 'COMPLETED', trials, completion: completionFor(trials) };
  }
  return {
    ...state,
    trials,
    currentTrialIndex: state.currentTrialIndex + 1,
    trialStartedAtMs: state.responseClosesAtMs,
    responseClosesAtMs: state.responseClosesAtMs + state.config.trialDurationMs,
    firstPressAtMs: null,
    duplicatePresses: 0,
  };
}

function advance(state: GoNoGoState, nowMs: number): GoNoGoState {
  assertMonotonic(nowMs, state.lastNowMs);
  let next = { ...state, lastNowMs: nowMs };
  if (next.lifecycle !== 'PLAYING') return next;
  while (next.lifecycle === 'PLAYING' && nowMs >= next.responseClosesAtMs)
    next = closeCurrentTrial(next);
  return next;
}

function transition(state: GoNoGoState, acceptedPress: boolean): GoNoGoTransition {
  const current = state.plan[state.currentTrialIndex];
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
  const totalDurationMs = state.config.totalTrials * state.config.trialDurationMs;
  const remainingCurrentTrialMs = state.lifecycle === 'PAUSED'
    ? (state.pauseRemainingMs ?? state.config.trialDurationMs)
    : Math.max(0, state.responseClosesAtMs - state.lastNowMs);
  const currentTrialElapsedMs = clamp(
    state.config.trialDurationMs - remainingCurrentTrialMs,
    0,
    state.config.trialDurationMs,
  );
  const activeElapsedMs = Math.min(totalDurationMs, state.trials.length * state.config.trialDurationMs + currentTrialElapsedMs);
  return {
    state,
    acceptedPress,
    visual: {
      mode: 'GO_NO_GO',
      trialNumber: Math.min(state.currentTrialIndex + 1, state.plan.length),
      stimulus: current?.stimulus ?? null,
      phase: state.lifecycle === 'COMPLETED' ? 'FEEDBACK' : 'STIMULUS',
      activeElapsedMs,
      remainingMs: Math.max(0, totalDurationMs - activeElapsedMs),
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
    if (next.lifecycle === 'PLAYING')
      next = { ...next, outOfWindowPresses: next.outOfWindowPresses + 1 };
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
    },
    false,
  );
}

export function resumeGoNoGo(state: GoNoGoState, nowMs: number): GoNoGoTransition {
  assertMonotonic(nowMs, state.lastNowMs);
  if (state.lifecycle !== 'PAUSED' || state.pauseRemainingMs === null) {
    return transition({ ...state, lastNowMs: nowMs }, false);
  }
  const elapsedInTrial = state.config.trialDurationMs - state.pauseRemainingMs;
  return transition(
    {
      ...state,
      lifecycle: 'PLAYING',
      lastNowMs: nowMs,
      trialStartedAtMs: nowMs - elapsedInTrial,
      responseClosesAtMs: nowMs + state.pauseRemainingMs,
      pauseRemainingMs: null,
    },
    false,
  );
}
