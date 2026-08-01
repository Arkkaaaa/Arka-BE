import { z } from 'zod';
import {
  DeviceConnectionStatusSchema,
  DeviceInventoryStatusSchema,
  DeviceReadinessCodeSchema,
  DisplayNameSchema,
  GameModeSchema,
  IsoDateSchema,
  ParticipantReferenceSchema,
  ParticipantStatusSchema,
  PublicIdSchema,
  SessionStatusSchema,
  UuidSchema,
} from './common.js';

export const InstitutionNameSchema = z.string().trim().min(2).max(120);
export const EmailRegistrationRequestSchema = z.object({
  name: InstitutionNameSchema,
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});
export type EmailRegistrationRequest = z.infer<typeof EmailRegistrationRequestSchema>;
export const SocialSignInResponseSchema = z.object({
  redirect: z.boolean(),
  url: z.string().url().optional(),
});

export const AuthCapabilitiesDtoSchema = z
  .object({
    emailPassword: z.literal(true),
    registration: z.literal(true),
    socialProviders: z.object({ google: z.boolean() }).strict(),
  })
  .strict();
export type AuthCapabilitiesDto = z.infer<typeof AuthCapabilitiesDtoSchema>;

export const InstitutionOnboardingRequestSchema = z.object({
  institutionName: InstitutionNameSchema,
});
export type InstitutionOnboardingRequest = z.infer<typeof InstitutionOnboardingRequestSchema>;
export const InstitutionOnboardingStatusSchema = z.object({
  required: z.boolean(),
  user: z.object({ email: z.string().email(), name: z.string().min(1), image: z.string().url().nullable() }),
  institution: z.object({ id: z.string().uuid(), name: InstitutionNameSchema }).nullable(),
  csrfToken: z.string().min(32),
});
export type InstitutionOnboardingStatus = z.infer<typeof InstitutionOnboardingStatusSchema>;

export const ProfileImageUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    );
  }, 'Foto profil harus berupa URL http atau https.');
export const ProfileImageDataSchema = z
  .string()
  .max(48_000)
  .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/u, 'Format foto profil tidak didukung.');
export const ProfileImageSchema = z.union([ProfileImageUrlSchema, ProfileImageDataSchema]);

export const MeDtoSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    image: ProfileImageSchema.nullable(),
  }),
  institution: z.object({
    id: z.string(),
    name: InstitutionNameSchema,
    status: z.literal('ACTIVE'),
  }),
  session: z.object({ id: z.string(), expiresAt: IsoDateSchema }),
  csrfToken: z.string().min(32),
});
export type MeDto = z.infer<typeof MeDtoSchema>;
export const UpdateProfileRequestSchema = z
  .object({
    name: DisplayNameSchema,
    image: ProfileImageSchema.nullable(),
    institutionName: InstitutionNameSchema,
  })
  .strict();
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const ResolveParticipantRequestSchema = z.object({
  participantReference: ParticipantReferenceSchema,
});
export const ResolveParticipantResponseSchema = z.object({ participantId: PublicIdSchema });
export const ParticipantDtoSchema = z.object({
  participantId: PublicIdSchema,
  displayName: DisplayNameSchema,
  image: ProfileImageSchema.nullable(),
  participantReference: ParticipantReferenceSchema,
  status: ParticipantStatusSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type ParticipantDto = z.infer<typeof ParticipantDtoSchema>;
export const ParticipantOverallMetricsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('MOTOR_GRIP'),
    averageScore: z.number().int().min(0).max(1000),
    averagePeakGripPercent: z.number().min(0).max(100),
    averageContinuousHoldMs: z.number().nonnegative(),
    targetCompletionPercent: z.number().min(0).max(100),
  }),
  z.object({
    mode: z.literal('GO_NO_GO'),
    averageScore: z.number().int().min(0).max(1000),
    averageAccuracyPercent: z.number().min(0).max(100),
    averageReactionMs: z.number().nonnegative().nullable(),
    totalTrials: z.number().int().nonnegative(),
    totalHits: z.number().int().nonnegative(),
    totalMisses: z.number().int().nonnegative(),
    totalFalsePositives: z.number().int().nonnegative(),
    totalCorrectRejections: z.number().int().nonnegative(),
  }),
  z.object({
    mode: z.literal('SEQUENCE_MEMORY'),
    averageScore: z.number().int().min(0).max(1000),
    averageMemorySpan: z.number().min(0).max(6),
    averageFirstResponseMs: z.number().nonnegative().nullable(),
    levelLatencies: z.array(z.object({
      level: z.number().int().min(1).max(6),
      latencyMs: z.number().nonnegative(),
      samples: z.number().int().positive(),
    })).max(6),
  }),
]);
export const ParticipantModeSummaryDtoSchema = z.object({
  mode: GameModeSchema,
  savedSessionsTotal: z.number().int().nonnegative(),
  latestSession: z.object({
    sessionId: UuidSchema,
    score: z.number().int().min(0).max(1000),
    completedAt: IsoDateSchema,
    gameRuleVersion: z.string().max(80),
  }).nullable(),
  overallMetrics: ParticipantOverallMetricsSchema.nullable(),
});
export const ParticipantDetailDtoSchema = ParticipantDtoSchema.extend({
  modeSummaries: z.array(ParticipantModeSummaryDtoSchema).length(3),
});
export type ParticipantDetailDto = z.infer<typeof ParticipantDetailDtoSchema>;
export const ParticipantSearchQuerySchema = z.object({
  query: z.string().trim().max(100).default(''),
});
export const ParticipantSearchResponseSchema = z.array(ParticipantDtoSchema).max(20);
export const CreateParticipantRequestSchema = z.object({ displayName: DisplayNameSchema });
export const UpdateParticipantRequestSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    image: ProfileImageSchema.nullable().optional(),
    participantReference: ParticipantReferenceSchema.optional(),
    status: ParticipantStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Minimal satu perubahan diperlukan');

export const DeviceDtoSchema = z.object({
  deviceId: z.string().min(3).max(80),
  label: z.string().min(1).max(100),
  inventoryStatus: DeviceInventoryStatusSchema,
  connectionStatus: DeviceConnectionStatusSchema,
  readinessCode: DeviceReadinessCodeSchema,
  readinessMessage: z.string().max(180),
  firmwareVersion: z.string().nullable(),
  capabilities: z.array(z.enum(['FSR', 'BUTTONS_4', 'LED', 'HAPTIC'])),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  lastSeenAt: IsoDateSchema.nullable(),
});
export type DeviceDto = z.infer<typeof DeviceDtoSchema>;
export const DashboardSummaryDtoSchema = z.object({
  readyDevices: z.number().int().nonnegative(),
  onlineDevices: z.number().int().nonnegative(),
  totalActiveDevices: z.number().int().nonnegative(),
  readinessMessage: z.string(),
});
export const DashboardActivityDtoSchema = z.object({
  activeParticipants: z.number().int().nonnegative(),
  savedSessionsTotal: z.number().int().nonnegative(),
  savedSessionsLast7Days: z.number().int().nonnegative(),
  latestSavedAt: IsoDateSchema.nullable(),
  dailySavedSessions: z
    .array(
      z.object({
        date: z.iso.date(),
        savedSessions: z.number().int().nonnegative(),
      }),
    )
    .length(7),
  modes: z.array(
    z.object({
      mode: GameModeSchema,
      savedSessions: z.number().int().nonnegative(),
      sessionsLast7Days: z.number().int().nonnegative(),
      latestSavedAt: IsoDateSchema.nullable(),
      latestRuleVersion: z.string().max(80).nullable(),
    }),
  ).length(3),
});
export type DashboardActivityDto = z.infer<typeof DashboardActivityDtoSchema>;
export const DashboardProgressDtoSchema = z.object({
  generatedAt: IsoDateSchema,
  participants: z.array(
    z.object({
      participantId: PublicIdSchema,
      displayName: DisplayNameSchema,
      savedSessionsTotal: z.number().int().nonnegative(),
      sessionsLast7Days: z.number().int().nonnegative(),
      activeWeeksLast4: z.number().int().min(0).max(4),
      lastSession: z
        .object({
          mode: GameModeSchema,
          completedAt: IsoDateSchema,
        })
        .nullable(),
      progress: z.discriminatedUnion('status', [
        z.object({ status: z.literal('NO_BASELINE'), scoreDelta: z.null() }),
        z.object({
          status: z.enum(['IMPROVED', 'MAINTAINED', 'LOWER']),
          scoreDelta: z.number().int().min(-1000).max(1000),
        }),
      ]),
      achievementStatus: z.enum([
        'NOT_STARTED',
        'FIRST_SESSION',
        'IMPROVED',
        'CONSISTENT',
        'CONTINUING',
      ]),
    }),
  ),
});
export type DashboardProgressDto = z.infer<typeof DashboardProgressDtoSchema>;
export const DashboardLeaderboardQuerySchema = z.object({ mode: GameModeSchema });
export const DashboardLeaderboardDtoSchema = z.object({
  mode: GameModeSchema,
  entries: z.array(
    z.object({
      rank: z.number().int().min(1).max(10),
      participantId: PublicIdSchema,
      displayName: DisplayNameSchema,
      score: z.number().int().min(0).max(1000),
      sessionsTotal: z.number().int().positive(),
      completedAt: IsoDateSchema,
    }),
  ).max(10),
});
export type DashboardLeaderboardDto = z.infer<typeof DashboardLeaderboardDtoSchema>;

export const CreatePreparationRequestSchema = z
  .object({
    mode: GameModeSchema,
    displayName: DisplayNameSchema,
    participantReference: ParticipantReferenceSchema.optional(),
    privacyAcknowledged: z.boolean(),
  })
  .refine((value) => value.mode === 'SEQUENCE_MEMORY' || value.participantReference !== undefined, {
    path: ['participantReference'],
    message: 'Kode peserta fasilitas wajib untuk mode ini.',
  });
export const PreparationStateSchema = z.enum([
  'WAITING_DEVICE',
  'BINDING_SETUP',
  'CALIBRATING',
  'PRACTICING',
  'READY',
  'CANCELLED',
  'EXPIRED',
]);
export const PreparationDtoSchema = z.object({
  preparationId: PublicIdSchema,
  setupId: UuidSchema,
  mode: GameModeSchema,
  displayName: DisplayNameSchema,
  state: PreparationStateSchema,
  expiresAt: IsoDateSchema,
  device: DeviceDtoSchema.pick({ deviceId: true, label: true, readinessCode: true }),
  setupBound: z.boolean(),
  calibration: z
    .object({
      valid: z.boolean(),
      gripPercent: z.number().min(0).max(100).optional(),
      pressed: z.boolean().optional(),
      message: z.string().optional(),
    })
    .nullable(),
  practiceCompleted: z.boolean(),
  canStart: z.boolean(),
});
export type PreparationDto = z.infer<typeof PreparationDtoSchema>;

export const CreateGameSessionRequestSchema = z.object({ preparationId: PublicIdSchema });
export const CreateGameSessionResponseSchema = z.object({
  sessionId: UuidSchema,
  status: z.literal('BINDING'),
  bindingDeadlineAt: IsoDateSchema,
});
export type CreateGameSessionResponse = z.infer<typeof CreateGameSessionResponseSchema>;
export const SessionCommandSchema = z.enum(['PAUSE', 'RESUME', 'ABORT']);
export const SessionStatusPatchRequestSchema = z.object({ command: SessionCommandSchema });

export const MotorGripMetricsSchema = z.object({
  mode: z.literal('MOTOR_GRIP'),
  peakGripPercent: z.number().min(0).max(100),
  continuousHoldMs: z.number().int().min(0).max(5000),
  targetCompleted: z.boolean(),
  sessionElapsedMs: z.number().int().min(0).max(30000),
});
export const GoNoGoMetricsSchema = z.object({
  mode: z.literal('GO_NO_GO'),
  totalTrials: z.number().int().nonnegative(),
  targetTrials: z.number().int().nonnegative(),
  nonTargetTrials: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  correctRejections: z.number().int().nonnegative(),
  accuracyPercent: z.number().min(0).max(100),
  meanHitReactionMs: z.number().nonnegative().nullable(),
});
export const SequenceMemoryMetricsSchema = z.object({
  mode: z.literal('SEQUENCE_MEMORY'),
  maxSequenceLength: z.number().int().nonnegative(),
  completedLevels: z.number().int().nonnegative(),
  wrongAttempts: z.number().int().nonnegative(),
  timedOutAttempts: z.number().int().nonnegative(),
  multiButtonAttempts: z.number().int().nonnegative(),
  meanFirstResponseMs: z.number().nonnegative().nullable(),
  meanInterButtonMs: z.number().nonnegative().nullable(),
  levelLatencies: z.array(
    z.object({ level: z.number().int().min(1).max(6), latencyMs: z.number().nonnegative() }),
  ).max(6).default([]),
  completionReason: z.enum(['LIVES_EXHAUSTED', 'LEVEL_CAP_REACHED']),
});
export const GameMetricsSchema = z.discriminatedUnion('mode', [
  MotorGripMetricsSchema,
  GoNoGoMetricsSchema,
  SequenceMemoryMetricsSchema,
]);
export type GameMetrics = z.infer<typeof GameMetricsSchema>;
export const AiSummaryDtoSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('PENDING') }),
  z.object({ status: z.literal('UNAVAILABLE') }),
  z.object({
    status: z.literal('READY'),
    summaryText: z.string().max(280),
    observations: z.array(z.string().max(140)).max(3),
  }),
]);
export const GameResultDtoSchema = z.object({
  score: z.number().int().min(0).max(1000),
  metrics: GameMetricsSchema,
  gameRuleVersion: z.string(),
  savedAt: IsoDateSchema,
  aiSummary: AiSummaryDtoSchema,
});
export type GameResultDto = z.infer<typeof GameResultDtoSchema>;
export const GameSessionDtoSchema = z.object({
  sessionId: UuidSchema,
  status: SessionStatusSchema,
  mode: GameModeSchema,
  displayName: DisplayNameSchema,
  participantId: PublicIdSchema.nullable(),
  startedAt: IsoDateSchema.nullable(),
  completedAt: IsoDateSchema.nullable(),
  failureReason: z.string().nullable(),
  result: GameResultDtoSchema.nullable(),
});
export type GameSessionDto = z.infer<typeof GameSessionDtoSchema>;

export const HistoryQuerySchema = z.object({
  mode: GameModeSchema.optional(),
  ruleVersion: z.string().max(80).optional(),
  cursor: z.string().max(256).optional(),
});
export const HistoryItemDtoSchema = z.object({
  sessionId: UuidSchema,
  mode: GameModeSchema,
  status: SessionStatusSchema,
  startedAt: IsoDateSchema.nullable(),
  completedAt: IsoDateSchema.nullable(),
  score: z.number().int().min(0).max(1000).nullable(),
  gameRuleVersion: z.string().nullable(),
  metrics: GameMetricsSchema.nullable(),
});
export const HistoryPageDtoSchema = z.object({
  items: z.array(HistoryItemDtoSchema).max(10),
  nextCursor: z.string().nullable(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});
export type HistoryPageDto = z.infer<typeof HistoryPageDtoSchema>;
export const LeaderboardQuerySchema = z.object({
  mode: GameModeSchema,
  ruleVersion: z.string().min(1).max(80),
});
export const LeaderboardDtoSchema = z.object({
  participantId: PublicIdSchema,
  mode: GameModeSchema,
  ruleVersion: z.string(),
  entries: z.array(
    z.object({
      rank: z.number().int().positive(),
      sessionId: UuidSchema,
      completedAt: IsoDateSchema,
      score: z.number().int().min(0).max(1000),
      metrics: GameMetricsSchema,
    }),
  ),
});
export type LeaderboardDto = z.infer<typeof LeaderboardDtoSchema>;
