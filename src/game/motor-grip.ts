import type { EngineCompletion } from './types.js';
import { assertMonotonic, clamp } from './types.js';

export interface MotorGripConfig {
  baselineRaw: number;
  calibratedMaxRaw: number;
  sustainThreshold: number;
  targetHoldMs: number;
  sessionDurationMs: number;
  telemetryGapMs: number;
}

export interface MotorGripMetrics {
  mode: 'MOTOR_GRIP';
  peakGripPercent: number;
  continuousHoldMs: number;
  targetCompleted: boolean;
  sessionElapsedMs: number;
}

export interface MotorGripState {
  readonly mode: 'MOTOR_GRIP';
  readonly lifecycle: 'PLAYING' | 'PAUSED' | 'COMPLETED';
  readonly config: Required<MotorGripConfig>;
  readonly lastNowMs: number;
  readonly activeElapsedMs: number;
  readonly lastGripPercent: number;
  readonly peakGripPercent: number;
  readonly currentHoldMs: number;
  readonly longestHoldMs: number;
  readonly lastSampleAtMs: number;
  readonly completion: EngineCompletion<MotorGripMetrics> | null;
}

export type MotorGripTransition = {
  readonly state: MotorGripState;
  readonly visual: {
    gripPercent: number;
    holdProgressMs: number;
    activeElapsedMs: number;
    message: string;
  };
  readonly completed: EngineCompletion<MotorGripMetrics> | null;
};

function validateConfig(config: MotorGripConfig): Required<MotorGripConfig> {
  const normalized = { ...config };
  if (
    !Number.isFinite(normalized.baselineRaw) ||
    !Number.isFinite(normalized.calibratedMaxRaw) ||
    normalized.calibratedMaxRaw <= normalized.baselineRaw
  ) {
    throw new RangeError('Calibration maximum must be above baseline');
  }
  if (
    normalized.sustainThreshold < 0 ||
    normalized.sustainThreshold > 100 ||
    !Number.isSafeInteger(normalized.targetHoldMs) ||
    normalized.targetHoldMs <= 0 ||
    !Number.isSafeInteger(normalized.sessionDurationMs) ||
    normalized.sessionDurationMs <= 0 ||
    !Number.isSafeInteger(normalized.telemetryGapMs) ||
    normalized.telemetryGapMs <= 0
  ) {
    throw new RangeError('Invalid motor grip rule configuration');
  }
  return normalized;
}

export function createMotorGrip(config: MotorGripConfig, nowMs: number): MotorGripState {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new RangeError('Invalid monotonic timestamp');
  return {
    mode: 'MOTOR_GRIP',
    lifecycle: 'PLAYING',
    config: validateConfig(config),
    lastNowMs: nowMs,
    activeElapsedMs: 0,
    lastGripPercent: 0,
    peakGripPercent: 0,
    currentHoldMs: 0,
    longestHoldMs: 0,
    lastSampleAtMs: nowMs,
    completion: null,
  };
}

export function normalizeGrip(
  raw: number,
  config: Pick<MotorGripConfig, 'baselineRaw' | 'calibratedMaxRaw'>,
): number {
  if (
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > 4095 ||
    config.calibratedMaxRaw <= config.baselineRaw
  ) {
    throw new RangeError('Invalid FSR sample or calibration');
  }
  return clamp(
    ((raw - config.baselineRaw) / (config.calibratedMaxRaw - config.baselineRaw)) * 100,
    0,
    100,
  );
}

function complete(state: MotorGripState): MotorGripState {
  const continuousHoldMs = Math.min(
    state.config.targetHoldMs,
    Math.max(state.longestHoldMs, state.currentHoldMs),
  );
  const targetCompleted = continuousHoldMs >= state.config.targetHoldMs;
  const metrics: MotorGripMetrics = {
    mode: 'MOTOR_GRIP',
    peakGripPercent: state.peakGripPercent,
    continuousHoldMs,
    targetCompleted,
    sessionElapsedMs: state.activeElapsedMs,
  };
  const score = clamp(
    (targetCompleted ? 500 : 0) +
      Math.floor((continuousHoldMs / state.config.targetHoldMs) * 300) +
      Math.round(state.peakGripPercent * 2),
    0,
    1000,
  );
  return {
    ...state,
    lifecycle: 'COMPLETED',
    completion: { lifecycle: 'COMPLETED', score, metrics, trials: [] },
  };
}

function advance(state: MotorGripState, nowMs: number): MotorGripState {
  assertMonotonic(nowMs, state.lastNowMs);
  if (state.lifecycle !== 'PLAYING' || state.completion) return { ...state, lastNowMs: nowMs };

  const remainingMs = state.config.sessionDurationMs - state.activeElapsedMs;
  const deltaMs = Math.min(nowMs - state.lastNowMs, remainingMs);
  let currentHoldMs = state.currentHoldMs;
  let longestHoldMs = state.longestHoldMs;
  if (nowMs - state.lastSampleAtMs > state.config.telemetryGapMs) {
    currentHoldMs = 0;
  } else if (state.lastGripPercent >= state.config.sustainThreshold) {
    currentHoldMs = Math.min(state.config.targetHoldMs, currentHoldMs + deltaMs);
    longestHoldMs = Math.max(longestHoldMs, currentHoldMs);
  }
  let next: MotorGripState = {
    ...state,
    lastNowMs: nowMs,
    activeElapsedMs: state.activeElapsedMs + deltaMs,
    currentHoldMs,
    longestHoldMs,
  };
  if (
    currentHoldMs >= state.config.targetHoldMs ||
    next.activeElapsedMs >= state.config.sessionDurationMs
  ) {
    next = complete(next);
  }
  return next;
}

function transition(state: MotorGripState): MotorGripTransition {
  const message = state.completion
    ? state.completion.metrics.targetCompleted
      ? 'Target tercapai'
      : 'Waktu selesai'
    : state.lifecycle === 'PAUSED'
      ? 'Dijeda'
      : state.currentHoldMs > 0
        ? 'Pertahankan genggaman'
        : 'Genggam dengan nyaman';
  return {
    state,
    visual: {
      gripPercent: state.lastGripPercent,
      holdProgressMs: state.currentHoldMs,
      activeElapsedMs: state.activeElapsedMs,
      message,
    },
    completed: state.completion,
  };
}

export function sampleMotorGrip(
  state: MotorGripState,
  raw: number,
  nowMs: number,
): MotorGripTransition {
  let next = advance(state, nowMs);
  if (next.lifecycle !== 'PLAYING') return transition(next);

  const gripPercent = normalizeGrip(raw, next.config);
  const wasAbove = next.lastGripPercent >= next.config.sustainThreshold;
  const isAbove = gripPercent >= next.config.sustainThreshold;
  let currentHoldMs = next.currentHoldMs;

  if (wasAbove && !isAbove) {
    currentHoldMs = 0;
  } else if (!wasAbove && isAbove) {
    currentHoldMs = 0;
  }

  next = {
    ...next,
    lastGripPercent: gripPercent,
    peakGripPercent: Math.max(next.peakGripPercent, gripPercent),
    currentHoldMs,
    lastSampleAtMs: nowMs,
  };
  return transition(next);
}

export function tickMotorGrip(state: MotorGripState, nowMs: number): MotorGripTransition {
  return transition(advance(state, nowMs));
}

export function pauseMotorGrip(state: MotorGripState, nowMs: number): MotorGripTransition {
  const next = advance(state, nowMs);
  if (next.lifecycle !== 'PLAYING') return transition(next);
  return transition({ ...next, lifecycle: 'PAUSED', currentHoldMs: 0 });
}

export function resumeMotorGrip(state: MotorGripState, nowMs: number): MotorGripTransition {
  assertMonotonic(nowMs, state.lastNowMs);
  if (state.lifecycle !== 'PAUSED') return transition({ ...state, lastNowMs: nowMs });
  return transition({
    ...state,
    lifecycle: 'PLAYING',
    lastNowMs: nowMs,
    lastGripPercent: 0,
    currentHoldMs: 0,
  });
}
