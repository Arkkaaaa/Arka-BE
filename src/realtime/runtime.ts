import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CreateGameSessionResponseSchema,
  GameSessionDtoSchema,
  PreparationDtoSchema,
  type CreateGameSessionResponse,
  type GameMetrics,
  type GameSessionDto,
  type PreparationDto,
} from '../schemas/index.js';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../middleware/errors.js';
import { writeAudit } from '../services/audit.js';
import {
  acquireMode3Lock,
  clearMode3Ownership,
  enqueueMode3Command,
  readMode3Association,
  readMode3Lock,
  refreshMode3Lock,
  transitionMode3Lock,
  updateMode3AssociationState,
  writeMode3Association,
} from '../device/commands.js';
import {
  MODE3_DEVICE_ID,
  MODE3_DEVICE_LABEL,
  readDeviceReadiness,
} from '../device/readiness.js';
import type { DeviceButtonCodeSchema } from '../device/protocol.js';
import {
  calibrateGoNoGo,
  calibrateMotorGrip,
  classifyFsrEdge,
  createGoNoGoPracticePlan,
  type FsrEdgeState,
  type PracticeTrial,
} from '../game/setup.js';
import {
  createMotorGrip,
  pauseMotorGrip,
  resumeMotorGrip,
  sampleMotorGrip,
  tickMotorGrip,
  type MotorGripState,
} from '../game/motor-grip.js';
import {
  createGoNoGo,
  pauseGoNoGo,
  pressGoNoGo,
  resumeGoNoGo,
  tickGoNoGo,
  type GoNoGoState,
} from '../game/go-no-go.js';
import {
  activeSequenceCue,
  createSequenceMemory,
  inputSequenceMemory,
  pauseSequenceMemory,
  resumeSequenceMemory,
  tickSequenceMemory,
  type SequenceMemoryState,
} from '../game/sequence-memory.js';
import type { RuntimeDependencies } from './types.js';
import { RealtimeEventStore } from './events.js';

const COUNTDOWN_MS = 3_000;
const RUNTIME_TTL_SECONDS = 3_600;
const PREPARATION_EXPIRY_SWEEP_MS = 1_000;
const MAX_CALIBRATION_WINDOW_SAMPLES = 256;
const FSR_RAW_MIN = 0;
const FSR_RAW_MAX = 4_095;
const COMPANION_PRESENCE_TTL_SECONDS = 20;
const COMPANION_STALE_AFTER_MS = 15_000;
const COMPANION_PRESENCE_CHECK_MS = 1_000;
const FINALIZATION_RECOVERY_MS = RUNTIME_TTL_SECONDS * 1_000;
const FINALIZATION_LEASE_MS = 30_000;
const FINALIZATION_RETRY_MS = 1_000;
const MODE3_LOCK_REFRESH_MS = 10_000;
const ADD_COMPANION_PRESENCE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return redis.call('ZCARD', KEYS[1])
`;
const REMOVE_COMPANION_PRESENCE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])
`;
const COUNT_COMPANION_PRESENCE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])
`;

const MotorRuleSchema = z
  .object({
    baselineMinimumSamples: z.number().int().positive().max(MAX_CALIBRATION_WINDOW_SAMPLES),
    activeMinimumSamples: z.number().int().positive().max(MAX_CALIBRATION_WINDOW_SAMPLES),
    minimumDeltaRaw: z.number().positive(),
    calibratedPercentile: z.number().min(0).max(1),
    sustainThreshold: z.number().min(0).max(100),
    targetHoldMs: z.number().int().positive(),
    sessionDurationMs: z.number().int().positive(),
    telemetryGapMs: z.number().int().positive(),
    ownerPresenceGraceMs: z.number().int().positive().optional(),
  })
  .passthrough();
const GoNoGoRuleSchema = z
  .object({
    releaseMinimumSamples: z.number().int().positive().max(MAX_CALIBRATION_WINDOW_SAMPLES),
    pressMinimumSamples: z.number().int().positive().max(MAX_CALIBRATION_WINDOW_SAMPLES),
    minimumDeltaRaw: z.number().positive(),
    pressPercentile: z.number().min(0).max(1),
    pressThresholdFraction: z.number().min(0).max(1),
    releaseThresholdFraction: z.number().min(0).max(1),
    totalTrials: z.literal(40),
    targetTrials: z.literal(14).optional(),
    trialDurationMs: z.literal(3_000),
    ownerPresenceGraceMs: z.number().int().positive().optional(),
  })
  .passthrough()
  .refine((value) => value.releaseThresholdFraction < value.pressThresholdFraction);
const SequenceRuleSchema = z
  .object({
    initialSequenceLength: z.number().int().min(1),
    maxSequenceLength: z.number().int().min(1).max(6).optional(),
    maxCompletedLevels: z.number().int().positive().optional(),
    initialLives: z.number().int().positive(),
    exampleItemMs: z.number().int().positive(),
    exampleGapMs: z.number().int().nonnegative(),
    responseTimeoutMs: z.literal(10_000),
    feedbackMs: z.number().int().nonnegative().optional(),
    ownerPresenceGraceMs: z.number().int().positive().optional(),
  })
  .passthrough();
const FinalizationPayloadSchema = z.object({
  score: z.number().int(),
  metrics: z.record(z.string(), z.unknown()),
  trials: z.array(z.unknown()),
  completedAt: z.string().datetime(),
});
type FinalizationPayload = z.infer<typeof FinalizationPayloadSchema>;
class PermanentFinalizationError extends Error {}

type Mode = 'MOTOR_GRIP' | 'GO_NO_GO' | 'SEQUENCE_MEMORY';
type ButtonCode = z.infer<typeof DeviceButtonCodeSchema>;
type EngineState = MotorGripState | GoNoGoState | SequenceMemoryState;
export interface TrustedDeviceInput {
  readonly receivedAtMs: number;
  readonly connectionId: string;
  readonly bootId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly sentAtMs: number;
}

interface CalibrationWindowState {
  readonly baselineWindow: number[];
  readonly activeWindow: number[];
  activeCursor?: number;
}

interface PreparationRuntime {
  readonly preparationId: string;
  readonly setupId: string;
  readonly mode: Mode;
  readonly lockId: string;
  readonly config: Record<string, unknown>;
  state: 'BINDING_SETUP' | 'CALIBRATING' | 'PRACTICING' | 'READY' | 'CANCELLED' | 'EXPIRED';
  setupBound: boolean;
  checkedButton: ButtonCode | null;
  calibrationState: CalibrationWindowState | null;
  calibration: Record<string, unknown> | null;
  edge: FsrEdgeState;
  practice: readonly PracticeTrial[];
  practiceIndex: number;
  practicePressed: boolean;
  practiceDeadlineMs: number | null;
  practiceFeedback?: 'CORRECT' | 'TRY_AGAIN' | 'WAIT';
  lastInput: TrustedDeviceInput | null;
}

interface SessionRuntime {
  readonly sessionId: string;
  readonly mode: Mode;
  readonly lockId: string;
  readonly ownerSessionId: string;
  readonly displayName: string;
  readonly config: Record<string, unknown>;
  readonly calibration: Record<string, unknown> | null;
  readonly seed: number;
  status: 'BINDING' | 'COUNTDOWN' | 'PLAYING' | 'PAUSED';
  deviceBound: boolean;
  companionPresent: boolean;
  companionEverPresent: boolean;
  companionGraceEndsAtMs: number | null;
  countdownEndsAtMs: number | null;
  lastSequenceCueKey?: string | null;
  engine: EngineState | null;
  edge: FsrEdgeState;
  lastInput: TrustedDeviceInput | null;
}

export interface OpenPreparationInput {
  readonly institutionId: string;
  readonly ownerSessionId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly mode: Mode;
  readonly displayName: string;
  readonly participantReference?: string;
  readonly privacyAcknowledged: boolean;
}
export interface CreateRuntimeSessionInput {
  readonly institutionId: string;
  readonly ownerSessionId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly preparationId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}
export interface CommandRuntimeSessionInput {
  readonly institutionId: string;
  readonly ownerSessionId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly command: 'PAUSE' | 'RESUME' | 'ABORT';
}

export interface RuntimeGateway {
  openPreparation(input: OpenPreparationInput): Promise<PreparationDto>;
  createSession(input: CreateRuntimeSessionInput): Promise<CreateGameSessionResponse>;
  commandSession(input: CommandRuntimeSessionInput): Promise<GameSessionDto>;
}

function prepKey(setupId: string): string {
  return `jalin:runtime:setup:${setupId}`;
}
function sessionKey(sessionId: string): string {
  return `jalin:runtime:session:${sessionId}`;
}
function companionPresenceKey(sessionId: string): string {
  return `jalin:presence:session:${sessionId}`;
}
function companionPresenceMember(ownerSessionId: string, connectionId: string): string {
  return `${ownerSessionId}:${connectionId}`;
}
function seedFromId(id: string): number {
  let seed = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1)
    seed = Math.imul(seed ^ id.charCodeAt(index), 0x01000193);
  return seed >>> 0;
}
function capabilityFor(mode: Mode): 'FSR_10HZ' | 'BUTTONS_4' {
  return mode === 'SEQUENCE_MEMORY' ? 'BUTTONS_4' : 'FSR_10HZ';
}

function parseRule(mode: Mode, value: Prisma.JsonValue): Record<string, unknown> {
  if (mode === 'MOTOR_GRIP') return MotorRuleSchema.parse(value);
  if (mode === 'GO_NO_GO') return GoNoGoRuleSchema.parse(value);
  return SequenceRuleSchema.parse(value);
}
function toInputJson(value: unknown): Prisma.InputJsonValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => (item === null ? null : toInputJson(item)));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = item === null ? null : toInputJson(item);
    }
    return result;
  }
  throw new TypeError('Value is not JSON serializable');
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value)) result[key] = item;
  return result;
}
function finalizationFailureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string' && code.length <= 80) return code;
  }
  return 'FINALIZATION_PERSISTENCE_ERROR';
}
function createCalibrationState(): CalibrationWindowState {
  return { baselineWindow: [], activeWindow: [], activeCursor: 0 };
}

function appendCalibrationSample(
  state: CalibrationWindowState,
  raw: number,
  baselineLimit: number,
  activeLimit: number,
): void {
  if (state.baselineWindow.length < baselineLimit) {
    state.baselineWindow.push(raw);
    return;
  }
  if (state.activeWindow.length < activeLimit) {
    state.activeWindow.push(raw);
    return;
  }
  const cursor = state.activeCursor ?? 0;
  state.activeWindow[cursor] = raw;
  state.activeCursor = (cursor + 1) % activeLimit;
}

function pauseEngine(engine: EngineState, nowMs: number): EngineState {
  if (engine.mode === 'MOTOR_GRIP') return pauseMotorGrip(engine, nowMs).state;
  if (engine.mode === 'GO_NO_GO') return pauseGoNoGo(engine, nowMs).state;
  return pauseSequenceMemory(engine, nowMs).state;
}

function resumeEngine(engine: EngineState, nowMs: number): EngineState {
  if (engine.mode === 'MOTOR_GRIP') return resumeMotorGrip(engine, nowMs).state;
  if (engine.mode === 'GO_NO_GO') return resumeGoNoGo(engine, nowMs).state;
  return resumeSequenceMemory(engine, nowMs).state;
}

export class AuthoritativeRuntime implements RuntimeGateway {
  readonly events: RealtimeEventStore;
  readonly #activeSessions = new Set<string>();
  readonly #activeSetups = new Set<string>();
  readonly #nextPresenceChecks = new Map<string, number>();
  readonly #nextFinalizationAttempts = new Map<string, number>();
  #nextPreparationExpirySweepMs = 0;
  #nextMode3LockRefreshMs = 0;
  #tickActive = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    readonly dependencies: RuntimeDependencies & {
      env?: {
        PREPARATION_TTL_MS: number;
        BINDING_DEADLINE_MS: number;
        IDEMPOTENCY_TTL_MS: number;
        DEVICE_COMMAND_TTL_MS: number;
      };
      participantIdentity: {
        ensureActiveParticipant(
          institutionId: string,
          input: { readonly displayName: string; readonly participantReference: string },
        ): Promise<{ id: string; participantId: string }>;
      };
    },
  ) {
    this.events = new RealtimeEventStore(dependencies.redis);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#tickActive) return;
      this.#tickActive = true;
      void this.tick()
        .catch((error) => this.dependencies.logger.error({ err: error }, 'Realtime tick gagal'))
        .finally(() => {
          this.#tickActive = false;
        });
    }, 100);
    this.#timer.unref();
  }

  stop(): Promise<void> {
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
    return Promise.resolve();
  }

  async recover(): Promise<void> {
    const now = new Date();
    const preparations = await this.dependencies.prisma.gamePreparation.findMany({
      where: {
        state: { in: ['WAITING_DEVICE', 'BINDING_SETUP', 'CALIBRATING', 'PRACTICING', 'READY'] },
      },
      select: { setupId: true, expiresAt: true },
    });
    for (const preparation of preparations) {
      if (preparation.expiresAt <= now) {
        await this.expirePreparation(preparation.setupId, now);
        continue;
      }
      const stored = await this.loadPreparation(preparation.setupId);
      if (stored) this.#activeSetups.add(preparation.setupId);
      else await this.cancelPreparation(preparation.setupId, 'RUNTIME_RECOVERY_UNAVAILABLE');
    }
    const sessions = await this.dependencies.prisma.gameSession.findMany({
      where: {
        status: { in: ['BINDING', 'COUNTDOWN', 'PLAYING', 'PAUSED', 'COMPLETED', 'SAVING'] },
      },
      select: { id: true, status: true },
    });
    for (const session of sessions) {
      if (session.status === 'COMPLETED' || session.status === 'SAVING')
        this.#nextFinalizationAttempts.set(session.id, Date.now());
      else {
        const stored = await this.loadSession(session.id);
        if (stored) this.#activeSessions.add(session.id);
        else await this.interruptSession(session.id, 'RUNTIME_RECOVERY_UNAVAILABLE');
      }
    }
    this.start();
  }

  async openPreparation(input: OpenPreparationInput): Promise<PreparationDto> {
    if (!input.privacyAcknowledged)
      throw new AppError(
        400,
        'privacy_acknowledgement_required',
        'Persetujuan privasi diperlukan.',
      );
    const ruleVersions = await this.dependencies.prisma.gameRuleVersion.findMany({
      where: {
        institutionId: input.institutionId,
        mode: input.mode,
        isActive: true,
        approvedAt: { not: null },
      },
      take: 2,
    });
    if (ruleVersions.length !== 1)
      throw new AppError(409, 'game_rule_unavailable', 'Aturan permainan belum tersedia.');
    const rule = ruleVersions[0]!;
    const config = parseRule(input.mode, rule.config);
    const readiness = await readDeviceReadiness(this.dependencies.redis);
    if (
      readiness.readinessCode !== 'READY' ||
      !readiness.capabilities.includes(capabilityFor(input.mode))
    )
      throw new AppError(409, 'device_unavailable', 'Perangkat yang sesuai belum siap.');

    const now = new Date();
    const ttlMs = this.dependencies.env?.PREPARATION_TTL_MS ?? 300_000;
    const setupId = randomUUID();
    const preparationId = randomBytes(24).toString('base64url');
    const lock = await acquireMode3Lock(this.dependencies.redis, {
      institutionId: input.institutionId,
      ownerSessionId: input.ownerSessionId,
      holderType: 'PREPARATION',
      preparationId,
      setupId,
    });
    if (!lock) throw new AppError(409, 'device_reserved', 'Perangkat sedang digunakan.');

    let preparation;
    try {
      const participant = input.participantReference
        ? await this.dependencies.participantIdentity.ensureActiveParticipant(input.institutionId, {
            displayName: input.displayName,
            participantReference: input.participantReference,
          })
        : null;
      preparation = await this.dependencies.prisma.gamePreparation.create({
        data: {
          preparationId,
          setupId,
          institutionId: input.institutionId,
          ownerSessionId: input.ownerSessionId,
          participantId: participant?.id ?? null,
          displayNameSnapshot: input.displayName,
          participantRefSnapshot: input.participantReference ?? null,
          mode: input.mode,
          ruleVersionId: rule.id,
          configSnapshot: toInputJson(config),
          firmwareSnapshot: { firmwareVersion: readiness.firmwareVersion },
          capabilitySnapshot: toInputJson(readiness.capabilities),
          state: 'BINDING_SETUP',
          privacyAcknowledgedAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      });
      await writeMode3Association(this.dependencies.redis, {
        lockId: lock.lockId,
        associationId: setupId,
        type: 'SETUP',
        state: 'BINDING',
      });
      await enqueueMode3Command(this.dependencies.redis, {
        lockId: lock.lockId,
        associationId: setupId,
        kind: 'SETUP_BIND',
        payload: {},
        expiresAt: new Date(
          now.getTime() + (this.dependencies.env?.DEVICE_COMMAND_TTL_MS ?? 30_000),
        ),
      });
    } catch (error) {
      await clearMode3Ownership(this.dependencies.redis, lock.lockId);
      throw error;
    }
    const runtime: PreparationRuntime = {
      preparationId,
      setupId,
      mode: input.mode,
      lockId: lock.lockId,
      config,
      state: 'BINDING_SETUP',
      setupBound: false,
      checkedButton: null,
      calibrationState: input.mode === 'SEQUENCE_MEMORY' ? null : createCalibrationState(),
      calibration: null,
      edge: { pressed: false, armed: true },
      practice: [],
      practiceIndex: 0,
      practicePressed: false,
      practiceDeadlineMs: null,
      lastInput: null,
    };
    await this.savePreparation(runtime);
    this.#activeSetups.add(setupId);
    await this.publishPreparation(runtime);
    return PreparationDtoSchema.parse({
      preparationId,
      setupId,
      mode: input.mode,
      displayName: input.displayName,
      state: preparation.state,
      expiresAt: preparation.expiresAt.toISOString(),
      device: {
        deviceId: MODE3_DEVICE_ID,
        label: MODE3_DEVICE_LABEL,
        readinessCode: readiness.readinessCode,
      },
      setupBound: false,
      calibration: null,
      practiceCompleted: false,
      canStart: false,
    });
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<CreateGameSessionResponse> {
    const existing = await this.dependencies.prisma.sessionCreationRequest.findUnique({
      where: {
        ownerSessionId_idempotencyKey: {
          ownerSessionId: input.ownerSessionId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint)
        throw new AppError(409, 'idempotency_conflict', 'Kunci idempotensi sudah dipakai.');
      return CreateGameSessionResponseSchema.parse(existing.responseSnapshot);
    }
    const preparation = await this.dependencies.prisma.gamePreparation.findFirst({
      where: {
        preparationId: input.preparationId,
        institutionId: input.institutionId,
        ownerSessionId: input.ownerSessionId,
      },
      include: { ruleVersion: true },
    });
    if (!preparation)
      throw new AppError(404, 'preparation_not_found', 'Persiapan tidak ditemukan.');
    if (preparation.state !== 'READY' || preparation.expiresAt <= new Date())
      throw new AppError(409, 'preparation_not_ready', 'Persiapan belum siap dimulai.');
    const setup = await this.loadPreparation(preparation.setupId);
    const currentLock = await readMode3Lock(this.dependencies.redis);
    if (
      !setup ||
      !currentLock ||
      currentLock.lockId !== setup.lockId ||
      currentLock.holderType !== 'PREPARATION' ||
      currentLock.preparationId !== preparation.preparationId
    )
      throw new AppError(409, 'preparation_not_ready', 'Persiapan belum siap dimulai.');
    if (!setup?.calibration && preparation.mode !== 'SEQUENCE_MEMORY')
      throw new AppError(409, 'calibration_required', 'Kalibrasi belum selesai.');
    if (preparation.mode === 'GO_NO_GO' && !preparation.practiceCompletedAt)
      throw new AppError(409, 'practice_required', 'Latihan belum selesai.');
    const sessionId = randomUUID();
    const now = new Date();
    const bindingDeadlineAt = new Date(
      now.getTime() + (this.dependencies.env?.BINDING_DEADLINE_MS ?? 20_000),
    );
    const response = CreateGameSessionResponseSchema.parse({
      sessionId,
      status: 'BINDING',
      bindingDeadlineAt: bindingDeadlineAt.toISOString(),
    });
    const sessionLock = await transitionMode3Lock(this.dependencies.redis, currentLock, {
      holderType: 'SESSION',
      sessionId,
      state: 'HELD',
    });
    if (!sessionLock)
      throw new AppError(409, 'device_reserved', 'Kepemilikan perangkat sudah berubah.');
    try {
      await this.dependencies.prisma.$transaction(async (tx) => {
        await tx.gameSession.create({
          data: {
            id: sessionId,
            institutionId: input.institutionId,
            ownerSessionId: input.ownerSessionId,
            participantId: preparation.participantId,
            preparationId: preparation.id,
            displayNameSnapshot: preparation.displayNameSnapshot,
            mode: preparation.mode,
            ruleVersionId: preparation.ruleVersionId,
            configSnapshot:
              preparation.configSnapshot === null
                ? Prisma.JsonNull
                : toInputJson(preparation.configSnapshot),
            capabilitySnapshot:
              preparation.capabilitySnapshot === null
                ? Prisma.JsonNull
                : toInputJson(preparation.capabilitySnapshot),
            ...(preparation.firmwareSnapshot === null
              ? {}
              : { firmwareSnapshot: toInputJson(preparation.firmwareSnapshot) }),
            ...(setup.calibration ? { calibrationSnapshot: toInputJson(setup.calibration) } : {}),
            gameRuleVersionSnapshot: preparation.ruleVersion.version,
            bindingDeadlineAt,
          },
        });
        const consumed = await tx.gamePreparation.updateMany({
          where: { id: preparation.id, state: 'READY', expiresAt: { gt: now } },
          data: { state: 'CONSUMED', consumedAt: now },
        });
        if (consumed.count === 0)
          throw new AppError(
            409,
            'preparation_not_ready',
            'Persiapan sudah digunakan atau kedaluwarsa.',
          );
        await tx.sessionCreationRequest.create({
          data: {
            ownerSessionId: input.ownerSessionId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            responseSnapshot: response,
            sessionId,
            expiresAt: new Date(
              now.getTime() + (this.dependencies.env?.IDEMPOTENCY_TTL_MS ?? 86_400_000),
            ),
          },
        });
      });
    } catch (error) {
      await transitionMode3Lock(this.dependencies.redis, sessionLock, {
        holderType: 'PREPARATION',
        sessionId: null,
        state: 'HELD',
      });
      throw error;
    }
    await updateMode3AssociationState(
      this.dependencies.redis,
      'SETUP',
      preparation.setupId,
      sessionLock.lockId,
      'UNBINDING',
    );
    await enqueueMode3Command(this.dependencies.redis, {
      lockId: sessionLock.lockId,
      associationId: preparation.setupId,
      kind: 'SETUP_UNBIND',
      payload: {},
      expiresAt: bindingDeadlineAt,
    });
    const runtime: SessionRuntime = {
      sessionId,
      mode: preparation.mode,
      lockId: sessionLock.lockId,
      ownerSessionId: input.ownerSessionId,
      displayName: preparation.displayNameSnapshot,
      config: parseRule(preparation.mode, preparation.configSnapshot),
      calibration: setup?.calibration ?? null,
      seed: seedFromId(sessionId),
      status: 'BINDING',
      deviceBound: false,
      companionPresent: false,
      companionEverPresent: false,
      companionGraceEndsAtMs: null,
      countdownEndsAtMs: null,
      lastSequenceCueKey: null,
      engine: null,
      edge: { pressed: false, armed: true },
      lastInput: null,
    };
    await this.saveSession(runtime);
    await this.dependencies.redis.del(prepKey(preparation.setupId));
    this.#activeSetups.delete(preparation.setupId);
    this.#activeSessions.add(sessionId);
    await this.publishSession(runtime, 'Menunggu perangkat dan pendamping.');
    return response;
  }

  async commandSession(input: CommandRuntimeSessionInput): Promise<GameSessionDto> {
    const session = await this.dependencies.prisma.gameSession.findFirst({
      where: {
        id: input.sessionId,
        institutionId: input.institutionId,
        ownerSessionId: input.ownerSessionId,
      },
      include: { result: true, aiSummary: true },
    });
    if (!session) throw new AppError(404, 'session_not_found', 'Sesi tidak ditemukan.');
    const runtime = await this.loadSession(session.id);
    if (input.command === 'ABORT') {
      if (
        ['SAVED', 'SAVE_FAILED', 'COMPLETED', 'SAVING', 'ABORTED', 'INTERRUPTED'].includes(
          session.status,
        )
      ) {
        return this.toSessionDto(session);
      }
      await this.terminateSession(session.id, 'ABORTED', 'CAREGIVER_ENDED');
      return this.readSessionDto(session.id, input.institutionId);
    }
    if (!runtime) throw new AppError(409, 'runtime_unavailable', 'Runtime sesi tidak tersedia.');
    const now = Date.now();
    if (input.command === 'PAUSE') {
      if (runtime.status !== 'PLAYING' || !runtime.engine)
        throw new AppError(409, 'invalid_session_transition', 'Sesi tidak dapat dijeda.');
      runtime.engine = pauseEngine(runtime.engine, now);
      runtime.status = 'PAUSED';
      const updated = await this.dependencies.prisma.gameSession.updateMany({
        where: { id: session.id, status: 'PLAYING' },
        data: {
          status: 'PAUSED',
          pausedAt: new Date(now),
          pausedState: toInputJson(runtime.engine),
        },
      });
      if (updated.count === 0) return this.readSessionDto(session.id, input.institutionId);
      await this.saveSession(runtime);
      await this.publishSession(runtime, 'Permainan dijeda.');
    } else {
      if (runtime.status !== 'PAUSED' || !runtime.engine)
        throw new AppError(409, 'invalid_session_transition', 'Sesi tidak dapat dilanjutkan.');
      runtime.engine = resumeEngine(runtime.engine, now);
      runtime.status = 'PLAYING';
      const updated = await this.dependencies.prisma.gameSession.updateMany({
        where: { id: session.id, status: 'PAUSED' },
        data: {
          status: 'PLAYING',
          pausedAt: null,
          pausedState: Prisma.DbNull,
        },
      });
      if (updated.count === 0) return this.readSessionDto(session.id, input.institutionId);
      await this.saveSession(runtime);
      await this.publishSession(runtime, 'Permainan dilanjutkan.');
    }
    return this.readSessionDto(session.id, input.institutionId);
  }

  async companionArrived(
    sessionId: string,
    ownerSessionId: string,
    connectionId: string,
  ): Promise<boolean> {
    const session = await this.dependencies.prisma.gameSession.findFirst({
      where: {
        id: sessionId,
        ownerSessionId,
        status: { in: ['BINDING', 'COUNTDOWN', 'PLAYING', 'PAUSED'] },
      },
      select: { id: true },
    });
    if (!session) return false;
    const runtime = await this.loadSession(sessionId);
    if (!runtime || runtime.ownerSessionId !== ownerSessionId) return false;
    await this.addCompanionPresence(sessionId, ownerSessionId, connectionId, Date.now());
    runtime.companionPresent = true;
    runtime.companionEverPresent = true;
    runtime.companionGraceEndsAtMs = null;
    await this.dependencies.prisma.gameSession.updateMany({
      where: { id: sessionId, status: { in: ['BINDING', 'COUNTDOWN', 'PLAYING', 'PAUSED'] } },
      data: { companionArrivedAt: new Date() },
    });
    await this.maybeBeginCountdown(runtime);
    return true;
  }

  async companionRefreshed(
    sessionId: string,
    ownerSessionId: string,
    connectionId: string,
  ): Promise<void> {
    const runtime = await this.loadSession(sessionId);
    if (!runtime || runtime.ownerSessionId !== ownerSessionId) return;
    await this.addCompanionPresence(sessionId, ownerSessionId, connectionId, Date.now());
    runtime.companionPresent = true;
    runtime.companionEverPresent = true;
    runtime.companionGraceEndsAtMs = null;
    await this.maybeBeginCountdown(runtime);
  }

  async companionDeparted(
    sessionId: string,
    ownerSessionId: string,
    connectionId: string,
  ): Promise<void> {
    const remaining = await this.removeCompanionPresence(sessionId, ownerSessionId, connectionId);
    const runtime = await this.loadSession(sessionId);
    if (!runtime || runtime.ownerSessionId !== ownerSessionId) return;
    if (remaining > 0) {
      runtime.companionPresent = true;
      runtime.companionGraceEndsAtMs = null;
      await this.saveSession(runtime);
      return;
    }
    await this.noteLastCompanionAbsent(runtime, Date.now());
  }

  async handleSetupBound(setupId: string): Promise<void> {
    const runtime = await this.loadPreparation(setupId);
    if (!runtime || runtime.state !== 'BINDING_SETUP') return;
    runtime.setupBound = true;
    runtime.state = runtime.mode === 'SEQUENCE_MEMORY' ? 'READY' : 'CALIBRATING';
    const updated = await this.dependencies.prisma.gamePreparation.updateMany({
      where: { setupId, state: 'BINDING_SETUP' },
      data: { state: runtime.state, setupBoundAt: new Date() },
    });
    if (updated.count === 0) return;
    await this.savePreparation(runtime);
    await this.publishPreparation(runtime);
  }

  async handleSetupUnbound(setupId: string, _commandId: string): Promise<void> {
    const session = await this.dependencies.prisma.gameSession.findFirst({
      where: { preparation: { setupId }, status: 'BINDING' },
    });
    if (!session) {
      const lock = await readMode3Lock(this.dependencies.redis);
      if (lock?.setupId === setupId) await clearMode3Ownership(this.dependencies.redis, lock.lockId);
      return;
    }
    const runtime = await this.loadSession(session.id);
    const lock = await readMode3Lock(this.dependencies.redis);
    if (!runtime || !lock || lock.lockId !== runtime.lockId || lock.sessionId !== session.id) return;
    await writeMode3Association(this.dependencies.redis, {
      lockId: lock.lockId,
      associationId: session.id,
      type: 'SESSION',
      state: 'BINDING',
    });
    await enqueueMode3Command(this.dependencies.redis, {
      lockId: lock.lockId,
      associationId: session.id,
      sessionId: session.id,
      kind: 'SESSION_BIND',
      payload: {},
      expiresAt: session.bindingDeadlineAt,
    });
  }

  async handleSessionBound(sessionId: string): Promise<void> {
    const updated = await this.dependencies.prisma.gameSession.updateMany({
      where: { id: sessionId, status: 'BINDING' },
      data: { sessionBoundAt: new Date() },
    });
    if (updated.count === 0) return;
    const runtime = await this.loadSession(sessionId);
    if (!runtime || runtime.status !== 'BINDING') return;
    await this.maybeBeginCountdown(runtime);
  }

  async handleFsr(
    association: { setupId?: string; sessionId?: string },
    raw: number,
    input: TrustedDeviceInput,
  ): Promise<void> {
    if (!Number.isInteger(raw) || raw < FSR_RAW_MIN || raw > FSR_RAW_MAX) {
      throw new RangeError('FSR telemetry must be an integer from 0 through 4095');
    }
    if (association.setupId) await this.handlePreparationFsr(association.setupId, raw, input);
    else if (association.sessionId)
      await this.handleSessionInput(association.sessionId, { kind: 'FSR', raw }, input);
  }

  async handleButton(
    association: { setupId?: string; sessionId?: string },
    buttonCode: ButtonCode,
    input: TrustedDeviceInput,
  ): Promise<void> {
    if (association.setupId) return;
    if (association.sessionId) {
      await this.handleSessionInput(association.sessionId, { kind: 'BUTTON', buttonCode }, input);
    }
  }

  async interruptMode3(reason: string): Promise<void> {
    const lock = await readMode3Lock(this.dependencies.redis);
    if (!lock) return;
    if (lock.holderType === 'PREPARATION') await this.cancelPreparation(lock.setupId, reason);
    else if (lock.sessionId) await this.interruptSession(lock.sessionId, reason);
  }

  async expireOwnerSession(ownerSessionId: string): Promise<void> {
    const preparations = await this.dependencies.prisma.gamePreparation.findMany({
      where: {
        ownerSessionId,
        state: { in: ['WAITING_DEVICE', 'BINDING_SETUP', 'CALIBRATING', 'PRACTICING', 'READY'] },
      },
      select: { setupId: true },
    });
    for (const preparation of preparations)
      await this.cancelPreparation(preparation.setupId, 'AUTH_SESSION_EXPIRED');
    const sessions = await this.dependencies.prisma.gameSession.findMany({
      where: { ownerSessionId, status: { in: ['BINDING', 'COUNTDOWN', 'PLAYING', 'PAUSED'] } },
      select: { id: true },
    });
    for (const session of sessions) await this.interruptSession(session.id, 'AUTH_SESSION_EXPIRED');
  }

  async interruptAssociation(
    association: { setupId?: string; sessionId?: string },
    reason: string,
  ): Promise<void> {
    if (association.setupId) await this.cancelPreparation(association.setupId, reason);
    if (association.sessionId) await this.interruptSession(association.sessionId, reason);
  }

  private async maybeBeginCountdown(runtime: SessionRuntime): Promise<void> {
    if (runtime.status !== 'BINDING') return;
    const now = Date.now();
    const boundSession = await this.dependencies.prisma.gameSession.findFirst({
      where: {
        id: runtime.sessionId,
        status: 'BINDING',
        sessionBoundAt: { not: null },
        bindingDeadlineAt: { gt: new Date(now) },
      },
      select: { id: true },
    });
    const companionPresent = (await this.countCompanionPresence(runtime.sessionId, now)) > 0;
    runtime.deviceBound = boundSession !== null;
    runtime.companionPresent = companionPresent;
    if (!runtime.deviceBound || !runtime.companionPresent) return;
    runtime.status = 'COUNTDOWN';
    runtime.countdownEndsAtMs = now + COUNTDOWN_MS;
    const activationId = randomUUID();
    const updated = await this.dependencies.prisma.gameSession.updateMany({
      where: {
        id: runtime.sessionId,
        status: 'BINDING',
        sessionBoundAt: { not: null },
        bindingDeadlineAt: { gt: new Date(now) },
      },
      data: {
        status: 'COUNTDOWN',
        activationId,
        activationSnapshot: { deviceBound: true, companionPresent: true },
        countdownEndsAt: new Date(runtime.countdownEndsAtMs),
      },
    });
    if (updated.count === 0) return;
    await this.saveSession(runtime);
    await this.publishSession(runtime, 'Permainan segera dimulai.');
  }

  private async handlePreparationFsr(
    setupId: string,
    raw: number,
    input: TrustedDeviceInput,
  ): Promise<void> {
    const runtime = await this.loadPreparation(setupId);
    if (
      !runtime ||
      !runtime.setupBound ||
      (runtime.state !== 'CALIBRATING' && runtime.state !== 'PRACTICING')
    )
      return;
    runtime.lastInput = input;
    if (runtime.state === 'CALIBRATING') {
      if (!runtime.calibrationState) return;
      if (runtime.mode === 'MOTOR_GRIP') {
        const rule = MotorRuleSchema.parse(runtime.config);
        appendCalibrationSample(
          runtime.calibrationState,
          raw,
          rule.baselineMinimumSamples,
          rule.activeMinimumSamples,
        );
        const calibration = calibrateMotorGrip(
          runtime.calibrationState.baselineWindow,
          runtime.calibrationState.activeWindow,
          rule,
        );
        if (calibration.valid) {
          runtime.calibration = {
            baselineRaw: calibration.baselineRaw,
            calibratedMaxRaw: calibration.calibratedMaxRaw,
          };
          runtime.calibrationState = null;
          runtime.state = 'READY';
          await this.markPreparationReady(runtime);
        }
      } else if (runtime.mode === 'GO_NO_GO') {
        const rule = GoNoGoRuleSchema.parse(runtime.config);
        appendCalibrationSample(
          runtime.calibrationState,
          raw,
          rule.releaseMinimumSamples,
          rule.pressMinimumSamples,
        );
        const calibration = calibrateGoNoGo(
          runtime.calibrationState.baselineWindow,
          runtime.calibrationState.activeWindow,
          rule,
        );
        if (calibration.valid) {
          runtime.calibration = {
            pressThreshold: calibration.pressThreshold,
            releaseThreshold: calibration.releaseThreshold,
          };
          runtime.calibrationState = null;
          runtime.state = 'PRACTICING';
          runtime.practice = createGoNoGoPracticePlan(seedFromId(runtime.setupId));
          runtime.practiceDeadlineMs = input.receivedAtMs + COUNTDOWN_MS;
          runtime.edge = { pressed: false, armed: true };
          const updated = await this.dependencies.prisma.gamePreparation.updateMany({
            where: { setupId, state: 'CALIBRATING' },
            data: { state: 'PRACTICING', calibrationSnapshot: toInputJson(runtime.calibration) },
          });
          if (updated.count === 0) return;
        }
      }
    } else if (runtime.mode === 'GO_NO_GO' && runtime.calibration) {
      const pressThreshold = Number(runtime.calibration['pressThreshold']);
      const releaseThreshold = Number(runtime.calibration['releaseThreshold']);
      const transition = classifyFsrEdge(runtime.edge, raw, pressThreshold, releaseThreshold);
      runtime.edge = transition.state;
      if (transition.edge === 'PRESS') runtime.practicePressed = true;
    }
    await this.savePreparation(runtime);
    await this.publishPreparation(runtime);
  }

  private async markPreparationReady(runtime: PreparationRuntime): Promise<void> {
    const updated = await this.dependencies.prisma.gamePreparation.updateMany({
      where: { setupId: runtime.setupId, state: { in: ['CALIBRATING', 'PRACTICING'] } },
      data: {
        state: 'READY',
        calibrationSnapshot:
          runtime.calibration === null ? Prisma.DbNull : toInputJson(runtime.calibration),
        ...(runtime.mode === 'GO_NO_GO' ? { practiceCompletedAt: new Date() } : {}),
      },
    });
    if (updated.count === 0) return;
    await this.savePreparation(runtime);
    await this.publishPreparation(runtime);
  }

  private async handleSessionInput(
    sessionId: string,
    input: { kind: 'FSR'; raw: number } | { kind: 'BUTTON'; buttonCode: ButtonCode },
    trusted: TrustedDeviceInput,
  ): Promise<void> {
    const runtime = await this.loadSession(sessionId);
    if (!runtime || runtime.status !== 'PLAYING' || !runtime.engine) return;
    const now = trusted.receivedAtMs;
    runtime.lastInput = trusted;
    let completed = null;
    if (runtime.engine.mode === 'MOTOR_GRIP' && input.kind === 'FSR') {
      const transition = sampleMotorGrip(runtime.engine, input.raw, now);
      runtime.engine = transition.state;
      completed = transition.completed;
    } else if (runtime.engine.mode === 'GO_NO_GO' && input.kind === 'FSR') {
      if (!runtime.calibration) return this.interruptSession(sessionId, 'CALIBRATION_MISSING');
      const edge = classifyFsrEdge(
        runtime.edge,
        input.raw,
        Number(runtime.calibration['pressThreshold']),
        Number(runtime.calibration['releaseThreshold']),
      );
      runtime.edge = edge.state;
      const transition =
        edge.edge === 'PRESS' ? pressGoNoGo(runtime.engine, now) : tickGoNoGo(runtime.engine, now);
      runtime.engine = transition.state;
      completed = transition.completed;
    } else if (runtime.engine.mode === 'SEQUENCE_MEMORY' && input.kind === 'BUTTON') {
      const transition = inputSequenceMemory(runtime.engine, input.buttonCode, now);
      runtime.engine = transition.state;
      completed = transition.completed;
    } else {
      this.dependencies.logger.warn(
        {
          sessionId,
          connectionId: trusted.connectionId,
          bootId: trusted.bootId,
          messageId: trusted.messageId,
          sequence: trusted.sequence,
        },
        'Input perangkat tidak sesuai mode sesi',
      );
      await this.interruptSession(sessionId, 'INPUT_MODE_MISMATCH');
      return;
    }
    await this.saveSession(runtime);
    await this.publishSession(runtime, 'Permainan berlangsung.');
    if (completed)
      await this.finalizeSession(runtime, completed.score, completed.metrics, completed.trials);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now >= this.#nextMode3LockRefreshMs) {
      this.#nextMode3LockRefreshMs = now + MODE3_LOCK_REFRESH_MS;
      const lock = await readMode3Lock(this.dependencies.redis);
      const active =
        lock?.state === 'HELD' &&
        (lock.holderType === 'PREPARATION'
          ? this.#activeSetups.has(lock.setupId)
          : lock.sessionId !== null && this.#activeSessions.has(lock.sessionId));
      if (lock && active) await refreshMode3Lock(this.dependencies.redis, lock.lockId);
    }
    if (now >= this.#nextPreparationExpirySweepMs) {
      this.#nextPreparationExpirySweepMs = now + PREPARATION_EXPIRY_SWEEP_MS;
      await this.expirePreparations(new Date(now));
    }
    for (const [sessionId, attemptAt] of [...this.#nextFinalizationAttempts]) {
      if (attemptAt > now) continue;
      this.#nextFinalizationAttempts.set(sessionId, now + FINALIZATION_RETRY_MS);
      const outcome = await this.recoverFinalization(sessionId);
      if (outcome) await this.finishFinalization(sessionId, outcome);
    }
    for (const setupId of [...this.#activeSetups]) {
      const runtime = await this.loadPreparation(setupId);
      if (!runtime) {
        this.#activeSetups.delete(setupId);
        continue;
      }
      if (
        runtime.state === 'PRACTICING' &&
        runtime.practiceDeadlineMs !== null &&
        now >= runtime.practiceDeadlineMs
      ) {
        const trial = runtime.practice[runtime.practiceIndex];
        if (trial) {
          const correct = trial.isTarget === runtime.practicePressed;
          runtime.practiceFeedback = correct ? 'CORRECT' : 'TRY_AGAIN';
          runtime.practiceIndex += 1;
          runtime.practicePressed = false;
          runtime.practiceDeadlineMs += COUNTDOWN_MS;
        }
        if (runtime.practiceIndex >= 4) {
          runtime.state = 'READY';
          await this.markPreparationReady(runtime);
        } else {
          await this.savePreparation(runtime);
          await this.publishPreparation(runtime);
        }
      }
    }
    for (const sessionId of [...this.#activeSessions]) {
      if (this.#nextFinalizationAttempts.has(sessionId)) continue;
      const runtime = await this.loadSession(sessionId);
      if (!runtime) {
        this.#activeSessions.delete(sessionId);
        continue;
      }
      if (now >= (this.#nextPresenceChecks.get(sessionId) ?? 0)) {
        this.#nextPresenceChecks.set(sessionId, now + COMPANION_PRESENCE_CHECK_MS);
        await this.reconcileCompanionPresence(runtime, now);
      }
      if (runtime.status === 'BINDING') {
        const session = await this.dependencies.prisma.gameSession.findUnique({
          where: { id: sessionId },
          select: { bindingDeadlineAt: true },
        });
        if (session && session.bindingDeadlineAt.getTime() <= now)
          await this.terminateSession(sessionId, 'ABORTED', 'BINDING_TIMEOUT');
      } else if (
        runtime.status === 'COUNTDOWN' &&
        runtime.countdownEndsAtMs !== null &&
        now >= runtime.countdownEndsAtMs
      ) {
        await this.startPlaying(runtime, now);
      } else if (runtime.status === 'PLAYING' && runtime.engine) {
        const transition =
          runtime.engine.mode === 'MOTOR_GRIP'
            ? tickMotorGrip(runtime.engine, now)
            : runtime.engine.mode === 'GO_NO_GO'
              ? tickGoNoGo(runtime.engine, now)
              : tickSequenceMemory(runtime.engine, now);
        runtime.engine = transition.state;
        await this.syncSequenceCue(runtime);
        await this.saveSession(runtime);
        await this.publishSession(runtime, 'Permainan berlangsung.');
        if (transition.completed)
          await this.finalizeSession(
            runtime,
            transition.completed.score,
            transition.completed.metrics,
            transition.completed.trials,
          );
      }
    }
  }

  private async syncSequenceCue(runtime: SessionRuntime): Promise<void> {
    if (runtime.engine?.mode !== 'SEQUENCE_MEMORY') return;
    const cue = activeSequenceCue(runtime.engine);
    if (!cue) return;
    const cueKey = `${runtime.engine.phaseStartedAtMs}:${cue.index}`;
    if (runtime.lastSequenceCueKey === cueKey) return;
    runtime.lastSequenceCueKey = cueKey;
    const remainingMs = Math.max(1, Math.min(1_000, cue.endsAtMs - Date.now()));
    await enqueueMode3Command(this.dependencies.redis, {
      lockId: runtime.lockId,
      associationId: runtime.sessionId,
      sessionId: runtime.sessionId,
      kind: 'FEEDBACK',
      payload: { action: `LED_${cue.item}`, expiresAfterMs: remainingMs },
      expiresAt: new Date(cue.endsAtMs),
    });
  }

  private async startPlaying(
    runtime: SessionRuntime,
    now: number,
    durableRecovery = false,
  ): Promise<void> {
    if (runtime.status !== 'COUNTDOWN') return;
    if (runtime.mode === 'MOTOR_GRIP') {
      const rule = MotorRuleSchema.parse(runtime.config);
      if (!runtime.calibration)
        return this.interruptSession(runtime.sessionId, 'CALIBRATION_MISSING');
      runtime.engine = createMotorGrip(
        {
          baselineRaw: Number(runtime.calibration['baselineRaw']),
          calibratedMaxRaw: Number(runtime.calibration['calibratedMaxRaw']),
          sustainThreshold: rule.sustainThreshold,
          targetHoldMs: rule.targetHoldMs,
          sessionDurationMs: rule.sessionDurationMs,
          telemetryGapMs: rule.telemetryGapMs,
        },
        now,
      );
    } else if (runtime.mode === 'GO_NO_GO') {
      const rule = GoNoGoRuleSchema.parse(runtime.config);
      runtime.engine = createGoNoGo(
        { totalTrials: rule.totalTrials, trialDurationMs: rule.trialDurationMs, targetPercent: 35 },
        runtime.seed,
        now,
      );
    } else {
      const rule = SequenceRuleSchema.parse(runtime.config);
      runtime.engine = createSequenceMemory(
        {
          initialSequenceLength: rule.initialSequenceLength,
          maxSequenceLength: rule.maxSequenceLength ?? 6,
          initialLives: rule.initialLives,
          exampleItemMs: rule.exampleItemMs,
          exampleGapMs: rule.exampleGapMs,
          responseTimeoutMs: rule.responseTimeoutMs,
          ...(rule.feedbackMs === undefined ? {} : { feedbackMs: rule.feedbackMs }),
        },
        runtime.seed,
        now,
      );
    }
    if (!durableRecovery) {
      const updated = await this.dependencies.prisma.gameSession.updateMany({
        where: { id: runtime.sessionId, status: 'COUNTDOWN' },
        data: {
          status: 'PLAYING',
          startedAt: new Date(now),
          countdownEndsAt: null,
        },
      });
      if (updated.count === 0) {
        const durable = await this.dependencies.prisma.gameSession.findUnique({
          where: { id: runtime.sessionId },
          select: { status: true, startedAt: true },
        });
        if (durable?.status !== 'PLAYING' || durable.startedAt === null) return;
        return this.startPlaying(runtime, durable.startedAt.getTime(), true);
      }
    }
    runtime.status = 'PLAYING';
    runtime.countdownEndsAtMs = null;
    await this.syncSequenceCue(runtime);
    await this.saveSession(runtime);
    await this.publishSession(runtime, 'Permainan dimulai.');
  }

  private async finalizeSession(
    runtime: SessionRuntime,
    score: number,
    metrics: GameMetrics,
    trials: readonly unknown[],
  ): Promise<void> {
    const now = new Date();
    const payload: FinalizationPayload = {
      score,
      metrics,
      trials: [...trials],
      completedAt: now.toISOString(),
    };
    const claimed = await this.dependencies.prisma.gameSession.updateMany({
      where: { id: runtime.sessionId, status: 'PLAYING' },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        finalizationPayload: toInputJson(payload),
        finalizationRecoveryExpiresAt: new Date(now.getTime() + FINALIZATION_RECOVERY_MS),
        finalizationLeaseToken: null,
        finalizationLeaseExpiresAt: null,
        finalizationFailedAt: null,
        terminalReason: null,
      },
    });
    this.#nextFinalizationAttempts.set(runtime.sessionId, Date.now());
    const outcome =
      claimed.count === 1
        ? await this.persistFinalization(runtime.sessionId)
        : await this.recoverFinalization(runtime.sessionId);
    if (outcome) await this.finishFinalization(runtime.sessionId, outcome);
  }

  private async recoverFinalization(sessionId: string): Promise<'SAVED' | 'SAVE_FAILED' | null> {
    const now = new Date();
    const session = await this.dependencies.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        finalizationRecoveryExpiresAt: true,
        finalizationLeaseExpiresAt: true,
        result: { select: { id: true } },
      },
    });
    if (!session) return null;
    if (session.status === 'SAVED' && session.result) return 'SAVED';
    if (session.status === 'SAVE_FAILED') return 'SAVE_FAILED';
    if (session.status !== 'COMPLETED' && session.status !== 'SAVING') return null;

    if (!session.finalizationRecoveryExpiresAt)
      return (await this.terminalizeFinalization(
        sessionId,
        'FINALIZATION_RECOVERY_DEADLINE_MISSING',
        now,
        { status: { in: ['COMPLETED', 'SAVING'] }, finalizationRecoveryExpiresAt: null },
      ))
        ? 'SAVE_FAILED'
        : null;
    if (session.finalizationRecoveryExpiresAt <= now) {
      const leaseExpired =
        session.status === 'COMPLETED' ||
        !session.finalizationLeaseExpiresAt ||
        session.finalizationLeaseExpiresAt <= now;
      if (!leaseExpired) return null;
      return (await this.terminalizeFinalization(sessionId, 'FINALIZATION_RECOVERY_EXPIRED', now, {
        finalizationRecoveryExpiresAt: { lte: now },
        OR: [
          { status: 'COMPLETED' },
          {
            status: 'SAVING',
            OR: [
              { finalizationLeaseExpiresAt: null },
              { finalizationLeaseExpiresAt: { lte: now } },
            ],
          },
        ],
      }))
        ? 'SAVE_FAILED'
        : null;
    }
    if (
      session.status === 'SAVING' &&
      session.finalizationLeaseExpiresAt &&
      session.finalizationLeaseExpiresAt > now
    )
      return null;
    return this.persistFinalization(sessionId);
  }

  private async persistFinalization(sessionId: string): Promise<'SAVED' | 'SAVE_FAILED' | null> {
    const leaseToken = randomUUID();
    const claimedAt = new Date();
    const claimed = await this.dependencies.prisma.gameSession.updateMany({
      where: {
        id: sessionId,
        finalizationFailedAt: null,
        finalizationRecoveryExpiresAt: { gt: claimedAt },
        OR: [
          { status: 'COMPLETED' },
          {
            status: 'SAVING',
            OR: [
              { finalizationLeaseExpiresAt: null },
              { finalizationLeaseExpiresAt: { lte: claimedAt } },
            ],
          },
        ],
      },
      data: {
        status: 'SAVING',
        finalizationLeaseToken: leaseToken,
        finalizationLeaseExpiresAt: new Date(claimedAt.getTime() + FINALIZATION_LEASE_MS),
      },
    });
    if (claimed.count === 0) return null;

    try {
      await this.dependencies.prisma.$transaction(async (tx) => {
        const session = await tx.gameSession.findFirstOrThrow({
          where: { id: sessionId, status: 'SAVING', finalizationLeaseToken: leaseToken },
          include: { result: true },
        });
        const parsed = FinalizationPayloadSchema.safeParse(session.finalizationPayload);
        if (!parsed.success)
          throw new PermanentFinalizationError('Authoritative finalization payload is invalid');
        const payload = parsed.data;
        if (!session.result) {
          const completedAt = new Date(payload.completedAt);
          await tx.gameResult.create({
            data: {
              sessionId: session.id,
              institutionId: session.institutionId,
              participantId: session.participantId,
              mode: session.mode,
              ruleVersionId: session.ruleVersionId,
              gameRuleVersion: session.gameRuleVersionSnapshot,
              score: payload.score,
              metrics: toInputJson(payload.metrics),
              ...(session.calibrationSnapshot === null
                ? {}
                : { calibrationContext: toInputJson(session.calibrationSnapshot) }),
              deviceSnapshot: toInputJson({
                deviceId: MODE3_DEVICE_ID,
                label: MODE3_DEVICE_LABEL,
                firmware: session.firmwareSnapshot,
                capabilities: session.capabilitySnapshot,
              }),
              lifecycleTrace: {
                completedBy: 'AUTHORITATIVE_RUNTIME',
                completedAt: payload.completedAt,
              },
              completedAt,
            },
          });
          for (const [index, trial] of payload.trials.entries()) {
            const value = recordFromUnknown(trial);
            await tx.gameTrial.create({
              data: {
                sessionId: session.id,
                trialIndex: typeof value['trialIndex'] === 'number' ? value['trialIndex'] : index,
                attemptIndex: typeof value['attemptIndex'] === 'number' ? value['attemptIndex'] : 0,
                kind: typeof value['outcome'] === 'string' ? value['outcome'] : session.mode,
                payload: toInputJson(value),
                startedAt: new Date(
                  typeof value['startedAtMs'] === 'number'
                    ? value['startedAtMs']
                    : typeof value['stimulusStartedAtMs'] === 'number'
                      ? value['stimulusStartedAtMs']
                      : completedAt.getTime(),
                ),
                closedAt: new Date(
                  typeof value['closedAtMs'] === 'number'
                    ? value['closedAtMs']
                    : typeof value['responseClosedAtMs'] === 'number'
                      ? value['responseClosedAtMs']
                      : completedAt.getTime(),
                ),
              },
            });
          }
          await tx.aiSessionSummary.create({
            data: { sessionId: session.id, status: 'PENDING' },
          });
        }
        const saved = await tx.gameSession.updateMany({
          where: { id: session.id, status: 'SAVING', finalizationLeaseToken: leaseToken },
          data: {
            status: 'SAVED',
            finalizationLeaseToken: null,
            finalizationLeaseExpiresAt: null,
            finalizationFailedAt: null,
            terminalReason: null,
          },
        });
        if (saved.count !== 1) throw new Error('Finalization lease lost');
        await writeAudit(
          tx,
          { institutionId: session.institutionId },
          {
            action: 'SESSION_FINALIZED',
            targetType: 'GameSession',
            targetId: session.id,
            metadata: { persistence: 'SAVED' },
          },
        );
      });
      return 'SAVED';
    } catch (error) {
      if (error instanceof PermanentFinalizationError) {
        const failed = await this.terminalizeFinalization(
          sessionId,
          finalizationFailureCode(error),
          new Date(),
          { status: 'SAVING', finalizationLeaseToken: leaseToken },
        );
        return failed ? 'SAVE_FAILED' : null;
      }
      this.dependencies.logger.warn(
        { err: error, sessionId },
        'Finalisasi sesi gagal sementara; akan dicoba ulang',
      );
      return null;
    }
  }

  private async finishFinalization(
    sessionId: string,
    outcome: 'SAVED' | 'SAVE_FAILED',
  ): Promise<void> {
    await this.requestSessionCleanup(sessionId);
    this.#nextFinalizationAttempts.delete(sessionId);
    this.#activeSessions.delete(sessionId);
    this.#nextPresenceChecks.delete(sessionId);
    await this.dependencies.redis.del(sessionKey(sessionId), companionPresenceKey(sessionId));
    await this.publishPersistedSession(
      sessionId,
      outcome === 'SAVED'
        ? 'Permainan selesai dan hasil tersimpan.'
        : 'Permainan selesai, tetapi hasil belum tersimpan.',
    );
  }

  private async terminalizeFinalization(
    sessionId: string,
    failureCode: string,
    now: Date,
    eligible: Prisma.GameSessionWhereInput,
  ): Promise<boolean> {
    return this.dependencies.prisma.$transaction(async (tx) => {
      const failed = await tx.gameSession.updateMany({
        where: { id: sessionId, finalizationFailedAt: null, ...eligible },
        data: {
          status: 'SAVE_FAILED',
          finalizationFailedAt: now,
          terminalReason: failureCode,
          finalizationLeaseToken: null,
          finalizationLeaseExpiresAt: null,
        },
      });
      if (failed.count === 0) return false;
      const session = await tx.gameSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { institutionId: true },
      });
      await writeAudit(
        tx,
        { institutionId: session.institutionId },
        {
          action: 'SESSION_FINALIZATION_FAILED',
          targetType: 'GameSession',
          targetId: sessionId,
          outcome: 'FAILURE',
          metadata: { failureCode },
        },
      );
      await tx.outboxEvent.create({
        data: {
          eventKey: `session-finalization-failed:${sessionId}`,
          type: 'SESSION_FINALIZATION_FAILED',
          payload: {
            institutionId: session.institutionId,
            sessionId,
            failureCode,
            failedAt: now.toISOString(),
          },
        },
      });
      return true;
    });
  }

  private async requestPreparationCleanup(setupId: string, reason: string): Promise<void> {
    const runtime = await this.loadPreparation(setupId);
    const lock = await readMode3Lock(this.dependencies.redis);
    if (!runtime || !lock || lock.lockId !== runtime.lockId || lock.setupId !== setupId) return;
    const association = await readMode3Association(this.dependencies.redis, 'SETUP', setupId);
    if (!association) {
      await clearMode3Ownership(this.dependencies.redis, lock.lockId);
      return;
    }
    if (association.state === 'UNBINDING') return;
    const releasing = await transitionMode3Lock(this.dependencies.redis, lock, {
      holderType: lock.holderType,
      sessionId: lock.sessionId,
      state: 'RELEASING',
    });
    if (!releasing) return;
    await updateMode3AssociationState(
      this.dependencies.redis,
      'SETUP',
      setupId,
      releasing.lockId,
      'UNBINDING',
    );
    await enqueueMode3Command(this.dependencies.redis, {
      lockId: releasing.lockId,
      associationId: setupId,
      kind: 'SETUP_UNBIND',
      payload: { reason },
      expiresAt: new Date(Date.now() + 30_000),
    });
  }

  private async requestSessionCleanup(sessionId: string): Promise<void> {
    const runtime = await this.loadSession(sessionId);
    const lock = await readMode3Lock(this.dependencies.redis);
    if (!runtime || !lock || lock.lockId !== runtime.lockId || lock.sessionId !== sessionId) return;
    const association = await readMode3Association(this.dependencies.redis, 'SESSION', sessionId);
    if (!association) {
      const setupAssociation = await readMode3Association(
        this.dependencies.redis,
        'SETUP',
        lock.setupId,
      );
      if (!setupAssociation) await clearMode3Ownership(this.dependencies.redis, lock.lockId);
      return;
    }
    if (association.state === 'UNBINDING') return;
    const releasing = await transitionMode3Lock(this.dependencies.redis, lock, {
      holderType: 'SESSION',
      sessionId,
      state: 'RELEASING',
    });
    if (!releasing) return;
    await updateMode3AssociationState(
      this.dependencies.redis,
      'SESSION',
      sessionId,
      releasing.lockId,
      'UNBINDING',
    );
    await enqueueMode3Command(this.dependencies.redis, {
      lockId: releasing.lockId,
      associationId: sessionId,
      sessionId,
      kind: 'FEEDBACK',
      payload: { action: 'HARD_STOP', expiresAfterMs: 1 },
      expiresAt: new Date(Date.now() + 1_000),
    });
    await enqueueMode3Command(this.dependencies.redis, {
      lockId: releasing.lockId,
      associationId: sessionId,
      sessionId,
      kind: 'SESSION_UNBIND',
      payload: {},
      expiresAt: new Date(Date.now() + 30_000),
    });
  }

  private async terminateSession(
    sessionId: string,
    status: 'ABORTED' | 'INTERRUPTED',
    reason: string,
  ): Promise<void> {
    const changed = await this.dependencies.prisma.gameSession.updateMany({
      where: { id: sessionId, status: { in: ['BINDING', 'COUNTDOWN', 'PLAYING', 'PAUSED'] } },
      data: { status, terminalReason: reason, completedAt: new Date() },
    });
    if (changed.count === 0) return;
    await this.requestSessionCleanup(sessionId);
    this.#activeSessions.delete(sessionId);
    this.#nextPresenceChecks.delete(sessionId);
    await this.dependencies.redis.del(sessionKey(sessionId), companionPresenceKey(sessionId));
    await this.publishPersistedSession(
      sessionId,
      status === 'ABORTED' ? 'Sesi diakhiri.' : 'Sesi terhenti demi keamanan.',
    );
  }

  private async interruptSession(sessionId: string, reason: string): Promise<void> {
    await this.terminateSession(sessionId, 'INTERRUPTED', reason);
  }

  private async cancelPreparation(setupId: string, reason: string): Promise<void> {
    await this.terminatePreparation(setupId, 'CANCELLED', reason, new Date());
  }

  private async expirePreparation(setupId: string, now: Date): Promise<void> {
    await this.terminatePreparation(setupId, 'EXPIRED', 'PREPARATION_EXPIRED', now);
  }

  private async expirePreparations(now: Date): Promise<void> {
    const expired = await this.dependencies.prisma.gamePreparation.findMany({
      where: {
        state: { in: ['WAITING_DEVICE', 'BINDING_SETUP', 'CALIBRATING', 'PRACTICING', 'READY'] },
        expiresAt: { lte: now },
      },
      select: { setupId: true },
    });
    for (const preparation of expired) await this.expirePreparation(preparation.setupId, now);
  }

  private async terminatePreparation(
    setupId: string,
    terminalState: 'CANCELLED' | 'EXPIRED',
    reason: string,
    now: Date,
  ): Promise<void> {
    const changed = await this.dependencies.prisma.gamePreparation.updateMany({
      where: {
        setupId,
        state: {
          in: ['WAITING_DEVICE', 'BINDING_SETUP', 'CALIBRATING', 'PRACTICING', 'READY'],
        },
        ...(terminalState === 'EXPIRED' ? { expiresAt: { lte: now } } : {}),
      },
      data: {
        state: terminalState,
        ...(terminalState === 'CANCELLED' ? { cancelledAt: now } : {}),
      },
    });
    if (changed.count === 0) return;
    await this.requestPreparationCleanup(setupId, reason);
    const runtime = await this.loadPreparation(setupId);
    if (runtime) {
      runtime.state = terminalState;
      runtime.calibrationState = null;
      await this.publishPreparation(runtime);
    }
    await this.dependencies.redis.del(prepKey(setupId));
    this.#activeSetups.delete(setupId);
  }

  private async addCompanionPresence(
    sessionId: string,
    ownerSessionId: string,
    connectionId: string,
    nowMs: number,
  ): Promise<number> {
    const count = await this.dependencies.redis.eval(
      ADD_COMPANION_PRESENCE_SCRIPT,
      1,
      companionPresenceKey(sessionId),
      String(nowMs - COMPANION_STALE_AFTER_MS),
      String(nowMs),
      companionPresenceMember(ownerSessionId, connectionId),
      String(COMPANION_PRESENCE_TTL_SECONDS),
    );
    return Number(count);
  }

  private async removeCompanionPresence(
    sessionId: string,
    ownerSessionId: string,
    connectionId: string,
  ): Promise<number> {
    const count = await this.dependencies.redis.eval(
      REMOVE_COMPANION_PRESENCE_SCRIPT,
      1,
      companionPresenceKey(sessionId),
      String(Date.now() - COMPANION_STALE_AFTER_MS),
      companionPresenceMember(ownerSessionId, connectionId),
    );
    return Number(count);
  }

  private async countCompanionPresence(sessionId: string, nowMs: number): Promise<number> {
    const count = await this.dependencies.redis.eval(
      COUNT_COMPANION_PRESENCE_SCRIPT,
      1,
      companionPresenceKey(sessionId),
      String(nowMs - COMPANION_STALE_AFTER_MS),
    );
    return Number(count);
  }

  private async noteLastCompanionAbsent(runtime: SessionRuntime, nowMs: number): Promise<void> {
    runtime.companionPresent = false;
    if (runtime.status === 'BINDING') {
      await this.saveSession(runtime);
      if (!runtime.companionEverPresent) return;
      if ((await this.countCompanionPresence(runtime.sessionId, Date.now())) > 0) return;
      await this.interruptSession(runtime.sessionId, 'COMPANION_DISCONNECTED');
      return;
    }
    if (runtime.companionGraceEndsAtMs === null) {
      const configured = Number(runtime.config['ownerPresenceGraceMs'] ?? 30_000);
      runtime.companionGraceEndsAtMs = nowMs + configured;
      await this.saveSession(runtime);
    }
  }

  private async reconcileCompanionPresence(runtime: SessionRuntime, nowMs: number): Promise<void> {
    const present = (await this.countCompanionPresence(runtime.sessionId, nowMs)) > 0;
    if (present) {
      if (!runtime.companionPresent || runtime.companionGraceEndsAtMs !== null) {
        runtime.companionPresent = true;
        runtime.companionEverPresent = true;
        runtime.companionGraceEndsAtMs = null;
        await this.maybeBeginCountdown(runtime);
      }
      return;
    }
    await this.noteLastCompanionAbsent(runtime, nowMs);
    if (
      runtime.status !== 'BINDING' &&
      runtime.companionGraceEndsAtMs !== null &&
      nowMs >= runtime.companionGraceEndsAtMs
    ) {
      if ((await this.countCompanionPresence(runtime.sessionId, Date.now())) > 0) return;
      await this.interruptSession(runtime.sessionId, 'COMPANION_DISCONNECTED');
    }
  }

  private async savePreparation(runtime: PreparationRuntime): Promise<void> {
    await this.dependencies.redis.set(
      prepKey(runtime.setupId),
      JSON.stringify(runtime),
      'EX',
      RUNTIME_TTL_SECONDS,
    );
  }
  private async loadPreparation(setupId: string): Promise<PreparationRuntime | null> {
    const encoded = await this.dependencies.redis.get(prepKey(setupId));
    if (!encoded) return null;
    try {
      return JSON.parse(encoded) as PreparationRuntime;
    } catch {
      return null;
    }
  }
  private async saveSession(runtime: SessionRuntime): Promise<void> {
    await this.dependencies.redis.set(
      sessionKey(runtime.sessionId),
      JSON.stringify(runtime),
      'EX',
      RUNTIME_TTL_SECONDS,
    );
  }
  private async loadSession(sessionId: string): Promise<SessionRuntime | null> {
    const encoded = await this.dependencies.redis.get(sessionKey(sessionId));
    if (!encoded) return null;
    try {
      return JSON.parse(encoded) as SessionRuntime;
    } catch {
      return null;
    }
  }

  private async publishPreparation(runtime: PreparationRuntime): Promise<void> {
    const trial = runtime.practice[runtime.practiceIndex];
    const instruction =
      runtime.state === 'BINDING_SETUP'
        ? 'Menghubungkan perangkat.'
        : runtime.state === 'CALIBRATING'
          ? 'Ikuti petunjuk kalibrasi dengan nyaman.'
          : runtime.state === 'PRACTICING'
            ? 'Latihan: genggam hanya saat Wayang muncul.'
            : runtime.state === 'READY'
              ? 'Persiapan selesai. Permainan siap dimulai.'
              : runtime.state === 'EXPIRED'
                ? 'Waktu persiapan telah habis.'
                : 'Persiapan dibatalkan.';
    await this.events.publish('setup', runtime.setupId, {
      protocolVersion: 1,
      type: 'setup.snapshot',
      setupId: runtime.setupId,
      payload: {
        state: runtime.state,
        instruction,
        setupBound: runtime.setupBound,
        checkedButton: runtime.checkedButton,
        buttonCheckComplete: runtime.mode === 'SEQUENCE_MEMORY' && runtime.setupBound,
        ...(runtime.calibration && typeof runtime.calibration['gripPercent'] === 'number'
          ? { gripPercent: runtime.calibration['gripPercent'] }
          : {}),
        ...(runtime.mode === 'GO_NO_GO' && runtime.calibration
          ? { pressed: runtime.edge.pressed }
          : {}),
        ...(trial ? { practiceStimulus: trial.stimulus } : {}),
        ...(runtime.practiceFeedback ? { practiceFeedback: runtime.practiceFeedback } : {}),
        practiceCompleted: runtime.state === 'READY',
        canStart: runtime.state === 'READY',
      },
    });
  }

  private visual(runtime: SessionRuntime): unknown {
    if (!runtime.engine) return null;
    if (runtime.engine.mode === 'MOTOR_GRIP')
      return tickMotorGrip(runtime.engine, runtime.engine.lastNowMs).visual;
    if (runtime.engine.mode === 'GO_NO_GO')
      return tickGoNoGo(runtime.engine, runtime.engine.lastNowMs).visual;
    return tickSequenceMemory(runtime.engine, runtime.engine.lastNowMs).visual;
  }

  private async publishSession(runtime: SessionRuntime, message: string): Promise<void> {
    const countdown =
      runtime.status === 'COUNTDOWN' && runtime.countdownEndsAtMs !== null
        ? Math.max(0, Math.min(3, Math.ceil((runtime.countdownEndsAtMs - Date.now()) / 1_000)))
        : null;
    await this.events.publish('session', runtime.sessionId, {
      protocolVersion: 1,
      type: 'session.snapshot',
      sessionId: runtime.sessionId,
      payload: {
        status: runtime.status,
        mode: runtime.mode,
        displayName: runtime.displayName,
        countdown,
        visual: this.visual(runtime),
        result: null,
        message,
      },
    });
  }

  private async publishPersistedSession(sessionId: string, message: string): Promise<void> {
    const session = await this.dependencies.prisma.gameSession.findUnique({
      where: { id: sessionId },
      include: { result: true, aiSummary: true },
    });
    if (!session) return;
    const dto = this.toSessionDto(session);
    await this.events.publish('session', sessionId, {
      protocolVersion: 1,
      type: 'session.snapshot',
      sessionId,
      payload: {
        status: dto.status,
        mode: dto.mode,
        displayName: session.displayNameSnapshot,
        countdown: null,
        visual: null,
        result: dto.result,
        message,
      },
    });
  }

  private async readSessionDto(sessionId: string, institutionId: string): Promise<GameSessionDto> {
    const session = await this.dependencies.prisma.gameSession.findFirst({
      where: { id: sessionId, institutionId },
      include: { result: true, aiSummary: true },
    });
    if (!session) throw new AppError(404, 'session_not_found', 'Sesi tidak ditemukan.');
    return this.toSessionDto(session);
  }

  private toSessionDto(session: {
    id: string;
    status: string;
    mode: Mode;
    displayNameSnapshot: string;
    participantId: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    terminalReason: string | null;
    gameRuleVersionSnapshot: string;
    result: { score: number; metrics: Prisma.JsonValue; savedAt: Date } | null;
    aiSummary: {
      status: string;
      summaryText: string | null;
      observations: Prisma.JsonValue | null;
    } | null;
  }): GameSessionDto {
    const aiSummary:
      | { status: 'READY'; summaryText: string; observations: unknown[] }
      | { status: 'UNAVAILABLE' }
      | { status: 'PENDING' } =
      session.aiSummary?.status === 'READY' && session.aiSummary.summaryText
        ? {
            status: 'READY',
            summaryText: session.aiSummary.summaryText,
            observations: Array.isArray(session.aiSummary.observations)
              ? session.aiSummary.observations
              : [],
          }
        : session.aiSummary?.status === 'UNAVAILABLE'
          ? { status: 'UNAVAILABLE' }
          : { status: 'PENDING' };
    return GameSessionDtoSchema.parse({
      sessionId: session.id,
      status: session.status,
      mode: session.mode,
      displayName: session.displayNameSnapshot,
      participantId: session.participantId,
      startedAt: session.startedAt?.toISOString() ?? null,
      completedAt: session.completedAt?.toISOString() ?? null,
      failureReason: session.terminalReason,
      result: session.result
        ? {
            score: session.result.score,
            metrics: session.result.metrics,
            gameRuleVersion: session.gameRuleVersionSnapshot,
            savedAt: session.result.savedAt.toISOString(),
            aiSummary,
          }
        : null,
    });
  }
}
