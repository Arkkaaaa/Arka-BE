import type { GoNoGoStimulus } from './go-no-go.js';

export interface MotorCalibrationConfig {
  baselineMinimumSamples: number;
  activeMinimumSamples: number;
  minimumDeltaRaw: number;
  calibratedPercentile: number;
}

export interface MotorCalibrationResult {
  readonly valid: boolean;
  readonly baselineRaw: number;
  readonly calibratedMaxRaw: number;
  readonly deltaRaw: number;
}

export interface GoNoGoCalibrationConfig {
  releaseMinimumSamples: number;
  pressMinimumSamples: number;
  minimumDeltaRaw: number;
  pressPercentile: number;
  pressThresholdFraction: number;
  releaseThresholdFraction: number;
}

export interface GoNoGoCalibrationResult {
  readonly valid: boolean;
  readonly baselineRaw: number;
  readonly pressedRaw: number;
  readonly deltaRaw: number;
  readonly pressThreshold: number;
  readonly releaseThreshold: number;
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0 || quantile < 0 || quantile > 1)
    throw new RangeError('Invalid percentile input');
  const sorted = [...samples].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function validateSamples(samples: readonly number[]): void {
  if (samples.some((sample) => !Number.isInteger(sample) || sample < 0 || sample > 4095)) {
    throw new RangeError('FSR calibration samples must be integers from 0 through 4095');
  }
}

export function calibrateMotorGrip(
  baselineSamples: readonly number[],
  activeSamples: readonly number[],
  config: MotorCalibrationConfig,
): MotorCalibrationResult {
  validateSamples(baselineSamples);
  validateSamples(activeSamples);
  if (
    baselineSamples.length < config.baselineMinimumSamples ||
    activeSamples.length < config.activeMinimumSamples
  ) {
    return { valid: false, baselineRaw: 0, calibratedMaxRaw: 0, deltaRaw: 0 };
  }
  const baselineRaw = percentile(baselineSamples, 0.5);
  const calibratedMaxRaw = percentile(activeSamples, config.calibratedPercentile);
  const deltaRaw = calibratedMaxRaw - baselineRaw;
  return { valid: deltaRaw >= config.minimumDeltaRaw, baselineRaw, calibratedMaxRaw, deltaRaw };
}

export function calibrateGoNoGo(
  releaseSamples: readonly number[],
  pressSamples: readonly number[],
  config: GoNoGoCalibrationConfig,
): GoNoGoCalibrationResult {
  validateSamples(releaseSamples);
  validateSamples(pressSamples);
  if (
    releaseSamples.length < config.releaseMinimumSamples ||
    pressSamples.length < config.pressMinimumSamples
  ) {
    return {
      valid: false,
      baselineRaw: 0,
      pressedRaw: 0,
      deltaRaw: 0,
      pressThreshold: 0,
      releaseThreshold: 0,
    };
  }
  const baselineRaw = percentile(releaseSamples, 0.5);
  const pressedRaw = percentile(pressSamples, config.pressPercentile);
  const deltaRaw = pressedRaw - baselineRaw;
  return {
    valid: deltaRaw >= config.minimumDeltaRaw,
    baselineRaw,
    pressedRaw,
    deltaRaw,
    pressThreshold: baselineRaw + deltaRaw * config.pressThresholdFraction,
    releaseThreshold: baselineRaw + deltaRaw * config.releaseThresholdFraction,
  };
}

export interface FsrEdgeState {
  readonly pressed: boolean;
  readonly armed: boolean;
}

export interface FsrEdgeTransition {
  readonly state: FsrEdgeState;
  readonly edge: 'PRESS' | 'RELEASE' | null;
  readonly instruction: 'RELEASE' | null;
}

export function classifyFsrEdge(
  state: FsrEdgeState,
  raw: number,
  pressThreshold: number,
  releaseThreshold: number,
): FsrEdgeTransition {
  if (!Number.isInteger(raw) || raw < 0 || raw > 4095 || releaseThreshold >= pressThreshold) {
    throw new RangeError('Invalid FSR hysteresis input');
  }
  if (state.pressed) {
    if (raw < releaseThreshold)
      return { state: { pressed: false, armed: true }, edge: 'RELEASE', instruction: null };
    return { state, edge: null, instruction: 'RELEASE' };
  }
  if (!state.armed && raw < releaseThreshold) {
    return { state: { pressed: false, armed: true }, edge: null, instruction: null };
  }
  if (state.armed && raw >= pressThreshold) {
    return { state: { pressed: true, armed: false }, edge: 'PRESS', instruction: 'RELEASE' };
  }
  return { state, edge: null, instruction: null };
}

export interface PracticeTrial {
  readonly index: number;
  readonly stimulus: GoNoGoStimulus;
  readonly isTarget: boolean;
}

export function createGoNoGoPracticePlan(): readonly PracticeTrial[] {
  return [{ index: 0, stimulus: 'WAYANG', isTarget: true }];
}
