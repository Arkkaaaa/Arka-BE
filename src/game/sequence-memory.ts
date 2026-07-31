import type { EngineCompletion } from './types.js';
import { assertMonotonic, clamp, mean } from './types.js';

export const MEMORY_BUTTONS = ['RED', 'GREEN', 'BLUE', 'YELLOW'] as const;
export type MemoryButton = (typeof MEMORY_BUTTONS)[number];
export type MemoryInput = MemoryButton | 'MULTIPLE';
export type MemoryAttemptOutcome = 'SUCCESS' | 'WRONG' | 'TIMEOUT' | 'MULTI_BUTTON';

export interface SequenceMemoryConfig {
  initialSequenceLength: number;
  maxSequenceLength: number;
  exampleItemMs: number;
  exampleGapMs: number;
  responseTimeoutMs: number;
  feedbackMs?: number;
}

export interface SequenceMemoryTrial {
  readonly trialIndex: number;
  readonly attemptIndex: number;
  readonly sequenceLength: number;
  readonly outcome: MemoryAttemptOutcome;
  readonly firstResponseMs: number | null;
  readonly interButtonMs: readonly number[];
  readonly startedAtMs: number;
  readonly closedAtMs: number;
}

export interface SequenceMemoryMetrics {
  mode: 'SEQUENCE_MEMORY';
  maxSequenceLength: number;
  completedLevels: number;
  wrongAttempts: number;
  timedOutAttempts: number;
  multiButtonAttempts: number;
  meanFirstResponseMs: number | null;
  meanInterButtonMs: number | null;
  completionReason: 'LIVES_EXHAUSTED' | 'LEVEL_CAP_REACHED';
}

type PendingAction = 'REPEAT' | 'NEXT_LEVEL';

export interface SequenceMemoryState {
  readonly mode: 'SEQUENCE_MEMORY';
  readonly lifecycle: 'PLAYING' | 'PAUSED' | 'COMPLETED';
  readonly config: Required<SequenceMemoryConfig>;
  readonly sequence: readonly MemoryButton[];
  readonly randomState: number;
  readonly phase: 'EXAMPLE' | 'RESPONSE' | 'FEEDBACK';
  readonly phaseStartedAtMs: number;
  readonly phaseEndsAtMs: number;
  readonly responseIndex: number;
  readonly errorIndex: number | null;
  readonly completedLevels: number;
  readonly maxSequenceLength: number;
  readonly wrongAttempts: number;
  readonly timedOutAttempts: number;
  readonly multiButtonAttempts: number;
  readonly attemptIndex: number;
  readonly attemptStartedAtMs: number;
  readonly firstResponseAtMs: number | null;
  readonly lastResponseAtMs: number | null;
  readonly interButtonMs: readonly number[];
  readonly lastNowMs: number;
  readonly pausedRemainingMs: number | null;
  readonly pendingAction: PendingAction | null;
  readonly feedback: 'CORRECT' | 'REPEAT' | 'ONE_BUTTON' | null;
  readonly trials: readonly SequenceMemoryTrial[];
  readonly completion: EngineCompletion<SequenceMemoryMetrics, SequenceMemoryTrial> | null;
}

export interface SequenceMemoryTransition {
  readonly state: SequenceMemoryState;
  readonly visual: {
    phase: 'EXAMPLE' | 'RESPONSE' | 'FEEDBACK';
    activeItem: MemoryButton | null;
    activeIndex: number | null;
    sequenceLength: number;
    responseIndex: number;
    errorIndex: number | null;
    feedback: 'CORRECT' | 'REPEAT' | 'ONE_BUTTON' | null;
  };
  readonly completed: EngineCompletion<SequenceMemoryMetrics, SequenceMemoryTrial> | null;
}

function normalizedConfig(config: SequenceMemoryConfig): Required<SequenceMemoryConfig> {
  const value = { ...config, feedbackMs: config.feedbackMs ?? 750 };
  if (
    !Number.isSafeInteger(value.initialSequenceLength) ||
    value.initialSequenceLength < 1 ||
    !Number.isSafeInteger(value.maxSequenceLength) ||
    value.maxSequenceLength < value.initialSequenceLength ||
    !Number.isSafeInteger(value.exampleItemMs) ||
    value.exampleItemMs <= 0 ||
    !Number.isSafeInteger(value.exampleGapMs) ||
    value.exampleGapMs < 0 ||
    !Number.isSafeInteger(value.responseTimeoutMs) ||
    value.responseTimeoutMs <= 0 ||
    !Number.isSafeInteger(value.feedbackMs) ||
    value.feedbackMs < 0
  ) {
    throw new RangeError('Invalid sequence memory rule configuration');
  }
  return value;
}

function nextRandom(state: number): readonly [number, number] {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  const next = value >>> 0 || 0x9e3779b9;
  return [next / 0x1_0000_0000, next];
}

function appendConstrained(
  sequence: readonly MemoryButton[],
  randomState: number,
): readonly [readonly MemoryButton[], number] {
  let cursor = randomState;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const [random, next] = nextRandom(cursor);
    cursor = next;
    const item = MEMORY_BUTTONS[Math.floor(random * MEMORY_BUTTONS.length)] as MemoryButton;
    const length = sequence.length;
    if (length < 2 || sequence[length - 1] !== item || sequence[length - 2] !== item) {
      return [[...sequence, item], cursor];
    }
  }
  const last = sequence.at(-1);
  const fallback = MEMORY_BUTTONS.find((item) => item !== last) as MemoryButton;
  return [[...sequence, fallback], cursor];
}

function exampleDuration(sequenceLength: number, config: Required<SequenceMemoryConfig>): number {
  return sequenceLength * config.exampleItemMs + (sequenceLength - 1) * config.exampleGapMs;
}

export function createSequenceMemory(
  config: SequenceMemoryConfig,
  seed: number,
  nowMs: number,
): SequenceMemoryState {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new RangeError('Invalid monotonic timestamp');
  const rule = normalizedConfig(config);
  let randomState = seed >>> 0 || 0x9e3779b9;
  let sequence: readonly MemoryButton[] = [];
  while (sequence.length < rule.initialSequenceLength)
    [sequence, randomState] = appendConstrained(sequence, randomState);
  return {
    mode: 'SEQUENCE_MEMORY',
    lifecycle: 'PLAYING',
    config: rule,
    sequence,
    randomState,
    phase: 'EXAMPLE',
    phaseStartedAtMs: nowMs,
    phaseEndsAtMs: nowMs + exampleDuration(sequence.length, rule),
    responseIndex: 0,
    errorIndex: null,
    completedLevels: 0,
    maxSequenceLength: 0,
    wrongAttempts: 0,
    timedOutAttempts: 0,
    multiButtonAttempts: 0,
    attemptIndex: 0,
    attemptStartedAtMs: nowMs,
    firstResponseAtMs: null,
    lastResponseAtMs: null,
    interButtonMs: [],
    lastNowMs: nowMs,
    pausedRemainingMs: null,
    pendingAction: null,
    feedback: null,
    trials: [],
    completion: null,
  };
}

export function activeSequenceCue(
  state: SequenceMemoryState,
): { readonly item: MemoryButton; readonly index: number; readonly endsAtMs: number } | null {
  if (state.phase !== 'EXAMPLE' || state.lifecycle !== 'PLAYING') return null;
  const offset = state.lastNowMs - state.phaseStartedAtMs;
  const stride = state.config.exampleItemMs + state.config.exampleGapMs;
  const index = Math.floor(offset / stride);
  if (index >= state.sequence.length || offset % stride >= state.config.exampleItemMs) return null;
  const item = state.sequence[index];
  if (!item) return null;
  return {
    item,
    index,
    endsAtMs: state.phaseStartedAtMs + index * stride + state.config.exampleItemMs,
  };
}

function metricsCompletion(
  state: SequenceMemoryState,
  reason: SequenceMemoryMetrics['completionReason'],
): SequenceMemoryState {
  const metrics: SequenceMemoryMetrics = {
    mode: 'SEQUENCE_MEMORY',
    maxSequenceLength: state.maxSequenceLength,
    completedLevels: state.completedLevels,
    wrongAttempts: state.wrongAttempts,
    timedOutAttempts: state.timedOutAttempts,
    multiButtonAttempts: state.multiButtonAttempts,
    meanFirstResponseMs: mean(
      state.trials
        .map((trial) => trial.firstResponseMs)
        .filter((value): value is number => value !== null),
    ),
    meanInterButtonMs: mean(state.trials.flatMap((trial) => trial.interButtonMs)),
    completionReason: reason,
  };
  const score = clamp(
    125 * metrics.maxSequenceLength +
      20 * metrics.completedLevels -
      50 * metrics.wrongAttempts -
      25 * metrics.timedOutAttempts,
    0,
    1000,
  );
  return {
    ...state,
    lifecycle: 'COMPLETED',
    completion: { lifecycle: 'COMPLETED', score, metrics, trials: state.trials },
  };
}

function recordAttempt(
  state: SequenceMemoryState,
  outcome: MemoryAttemptOutcome,
  nowMs: number,
): SequenceMemoryState {
  const trial: SequenceMemoryTrial = {
    trialIndex: state.completedLevels,
    attemptIndex: state.attemptIndex,
    sequenceLength: state.sequence.length,
    outcome,
    firstResponseMs:
      state.firstResponseAtMs === null ? null : state.firstResponseAtMs - state.attemptStartedAtMs,
    interButtonMs: state.interButtonMs,
    startedAtMs: state.attemptStartedAtMs,
    closedAtMs: nowMs,
  };
  return { ...state, trials: [...state.trials, trial] };
}

function beginExample(
  state: SequenceMemoryState,
  nowMs: number,
  sequence: readonly MemoryButton[],
  randomState: number,
): SequenceMemoryState {
  return {
    ...state,
    sequence,
    randomState,
    phase: 'EXAMPLE',
    phaseStartedAtMs: nowMs,
    phaseEndsAtMs: nowMs + exampleDuration(sequence.length, state.config),
    responseIndex: 0,
    errorIndex: null,
    attemptIndex: state.pendingAction === 'REPEAT' ? state.attemptIndex + 1 : 0,
    firstResponseAtMs: null,
    lastResponseAtMs: null,
    interButtonMs: [],
    pendingAction: null,
    feedback: null,
  };
}

function applyPendingAction(state: SequenceMemoryState, nowMs: number): SequenceMemoryState {
  if (state.pendingAction === 'REPEAT')
    return beginExample(state, nowMs, state.sequence, state.randomState);
  if (state.pendingAction === 'NEXT_LEVEL') {
    const [sequence, randomState] = appendConstrained(state.sequence, state.randomState);
    return beginExample(state, nowMs, sequence, randomState);
  }
  return state;
}

function failAttempt(
  state: SequenceMemoryState,
  outcome: 'WRONG' | 'TIMEOUT' | 'MULTI_BUTTON',
  nowMs: number,
): SequenceMemoryState {
  let next = recordAttempt(state, outcome, nowMs);
  next = {
    ...next,
    errorIndex: next.responseIndex,
    wrongAttempts: next.wrongAttempts + (outcome === 'TIMEOUT' ? 0 : 1),
    timedOutAttempts: next.timedOutAttempts + (outcome === 'TIMEOUT' ? 1 : 0),
    multiButtonAttempts: next.multiButtonAttempts + (outcome === 'MULTI_BUTTON' ? 1 : 0),
    phase: 'FEEDBACK',
    phaseStartedAtMs: nowMs,
    phaseEndsAtMs: nowMs + next.config.feedbackMs,
    pendingAction: 'REPEAT',
    feedback: outcome === 'MULTI_BUTTON' ? 'ONE_BUTTON' : 'REPEAT',
  };
  return next;
}

function advance(state: SequenceMemoryState, nowMs: number): SequenceMemoryState {
  assertMonotonic(nowMs, state.lastNowMs);
  let next = { ...state, lastNowMs: nowMs };
  if (next.lifecycle !== 'PLAYING') return next;

  for (
    let guard = 0;
    guard < 64 && next.lifecycle === 'PLAYING' && nowMs >= next.phaseEndsAtMs;
    guard += 1
  ) {
    const boundary = next.phaseEndsAtMs;
    if (next.phase === 'EXAMPLE') {
      next = {
        ...next,
        phase: 'RESPONSE',
        phaseStartedAtMs: boundary,
        phaseEndsAtMs: boundary + next.config.responseTimeoutMs,
        attemptStartedAtMs: boundary,
        responseIndex: 0,
        firstResponseAtMs: null,
        lastResponseAtMs: null,
        interButtonMs: [],
        feedback: null,
      };
    } else if (next.phase === 'RESPONSE') {
      next = failAttempt(next, 'TIMEOUT', boundary);
    } else {
      next = applyPendingAction(next, boundary);
    }
  }
  return next;
}

function transition(state: SequenceMemoryState): SequenceMemoryTransition {
  const cue = activeSequenceCue(state);
  return {
    state,
    visual: {
      phase: state.phase,
      activeItem: cue?.item ?? null,
      activeIndex: cue?.index ?? null,
      sequenceLength: state.sequence.length,
      responseIndex: state.responseIndex,
      errorIndex: state.errorIndex,
      feedback: state.feedback,
    },
    completed: state.completion,
  };
}

export function inputSequenceMemory(
  state: SequenceMemoryState,
  input: MemoryInput,
  nowMs: number,
): SequenceMemoryTransition {
  let next = advance(state, nowMs);
  if (next.lifecycle !== 'PLAYING' || next.phase !== 'RESPONSE') return transition(next);
  const firstResponseAtMs = next.firstResponseAtMs ?? nowMs;
  next = { ...next, firstResponseAtMs };
  if (input === 'MULTIPLE') return transition(failAttempt(next, 'MULTI_BUTTON', nowMs));
  if (input !== next.sequence[next.responseIndex])
    return transition(failAttempt(next, 'WRONG', nowMs));

  const interButtonMs =
    next.lastResponseAtMs === null
      ? next.interButtonMs
      : [...next.interButtonMs, nowMs - next.lastResponseAtMs];
  next = { ...next, lastResponseAtMs: nowMs, interButtonMs };

  const responseIndex = next.responseIndex + 1;
  if (responseIndex < next.sequence.length)
    return transition({ ...next, responseIndex, feedback: 'CORRECT' });

  next = recordAttempt({ ...next, responseIndex }, 'SUCCESS', nowMs);
  const completedLevels = next.completedLevels + 1;
  next = {
    ...next,
    completedLevels,
    maxSequenceLength: Math.max(next.maxSequenceLength, next.sequence.length),
    phase: 'FEEDBACK',
    phaseStartedAtMs: nowMs,
    phaseEndsAtMs: nowMs + next.config.feedbackMs,
    pendingAction: 'NEXT_LEVEL',
    feedback: 'CORRECT',
  };
  if (next.sequence.length >= next.config.maxSequenceLength)
    next = metricsCompletion(next, 'LEVEL_CAP_REACHED');
  return transition(next);
}

export function tickSequenceMemory(
  state: SequenceMemoryState,
  nowMs: number,
): SequenceMemoryTransition {
  return transition(advance(state, nowMs));
}

export function pauseSequenceMemory(
  state: SequenceMemoryState,
  nowMs: number,
): SequenceMemoryTransition {
  const next = advance(state, nowMs);
  if (next.lifecycle !== 'PLAYING') return transition(next);
  return transition(
    {
      ...next,
      lifecycle: 'PAUSED',
      pausedRemainingMs: next.phaseEndsAtMs - nowMs,
    },
  );
}

export function resumeSequenceMemory(
  state: SequenceMemoryState,
  nowMs: number,
): SequenceMemoryTransition {
  assertMonotonic(nowMs, state.lastNowMs);
  if (state.lifecycle !== 'PAUSED' || state.pausedRemainingMs === null) {
    return transition({ ...state, lastNowMs: nowMs });
  }
  const elapsedInPhase = state.phaseEndsAtMs - state.phaseStartedAtMs - state.pausedRemainingMs;
  const phaseStartedAtMs = nowMs - elapsedInPhase;
  return transition(
    {
      ...state,
      lifecycle: 'PLAYING',
      lastNowMs: nowMs,
      phaseStartedAtMs,
      phaseEndsAtMs: nowMs + state.pausedRemainingMs,
      attemptStartedAtMs: state.phase === 'RESPONSE' ? phaseStartedAtMs : state.attemptStartedAtMs,
      pausedRemainingMs: null,
    },
  );
}
