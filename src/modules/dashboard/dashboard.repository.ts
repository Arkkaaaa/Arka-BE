import type { GameMode, PrismaClient } from '../../generated/prisma/client.js';
import type { DeviceRepository, DeviceSnapshot } from '../device/device.repository.js';

export interface DashboardActivityRecord {
  readonly activeParticipants: number;
  readonly savedSessionsTotal: number;
  readonly savedSessionsLast7Days: number;
  readonly latestSavedAt: Date | null;
  readonly modes: readonly {
    readonly mode: GameMode;
    readonly savedSessions: number;
    readonly sessionsLast7Days: number;
    readonly latestSavedAt: Date | null;
    readonly latestRuleVersion: string | null;
  }[];
}

const MODES: readonly GameMode[] = ['MOTOR_GRIP', 'GO_NO_GO', 'SEQUENCE_MEMORY'];

export class DashboardRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly devices: DeviceRepository,
  ) {}

  listInstitutionDeviceSnapshots(institutionId: string): Promise<DeviceSnapshot[]> {
    return this.devices.listInstitutionDevices(institutionId);
  }

  async activity(institutionId: string): Promise<DashboardActivityRecord> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const savedWhere = { institutionId, session: { status: 'SAVED' as const, institutionId } };
    const [
      activeParticipants,
      savedSessionsTotal,
      savedSessionsLast7Days,
      latest,
      totalsByMode,
      recentByMode,
      latestByMode,
    ] = await Promise.all([
      this.prisma.participant.count({ where: { institutionId, status: 'ACTIVE' } }),
      this.prisma.gameResult.count({ where: savedWhere }),
      this.prisma.gameResult.count({
        where: { ...savedWhere, completedAt: { gte: sevenDaysAgo } },
      }),
      this.prisma.gameResult.findFirst({
        where: savedWhere,
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
      this.prisma.gameResult.groupBy({
        by: ['mode'],
        where: savedWhere,
        _count: { _all: true },
        _max: { completedAt: true },
      }),
      this.prisma.gameResult.groupBy({
        by: ['mode'],
        where: { ...savedWhere, completedAt: { gte: sevenDaysAgo } },
        _count: { _all: true },
      }),
      Promise.all(
        MODES.map((mode) =>
          this.prisma.gameResult.findFirst({
            where: { ...savedWhere, mode },
            orderBy: { completedAt: 'desc' },
            select: { mode: true, completedAt: true, gameRuleVersion: true },
          }),
        ),
      ),
    ]);

    return {
      activeParticipants,
      savedSessionsTotal,
      savedSessionsLast7Days,
      latestSavedAt: latest?.completedAt ?? null,
      modes: MODES.map((mode) => {
        const total = totalsByMode.find((entry) => entry.mode === mode);
        const recent = recentByMode.find((entry) => entry.mode === mode);
        const latestMode = latestByMode.find((entry) => entry?.mode === mode);
        return {
          mode,
          savedSessions: total?._count._all ?? 0,
          sessionsLast7Days: recent?._count._all ?? 0,
          latestSavedAt: total?._max.completedAt ?? null,
          latestRuleVersion: latestMode?.gameRuleVersion ?? null,
        };
      }),
    };
  }
}
