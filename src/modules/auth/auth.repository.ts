import type { RedisClient } from '../../db/redis.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

const ACTIVITY_KEY_PREFIX = 'jalin:auth-activity:';
const EXPIRY_LOCK_KEY_PREFIX = 'jalin:auth-expiry-lock:';

export interface SessionExpiryRecord {
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface SessionIdentityRecord {
  readonly userId: string;
  readonly institutionId: string;
}

export interface SessionTouchRecord extends SessionExpiryRecord, SessionIdentityRecord {}

function activityKey(sessionId: string): string {
  return `${ACTIVITY_KEY_PREFIX}${sessionId}`;
}

function expiryLockKey(sessionId: string): string {
  return `${EXPIRY_LOCK_KEY_PREFIX}${sessionId}`;
}

export class AuthRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: RedisClient,
  ) {}

  public async findActiveSession(
    ownerSessionId: string,
    userId: string,
    institutionId: string,
  ): Promise<SessionExpiryRecord | null> {
    return this.prisma.session.findFirst({
      where: {
        id: ownerSessionId,
        userId,
        user: { institutionId, institution: { status: 'ACTIVE' } },
      },
      select: { createdAt: true, expiresAt: true },
    });
  }

  public async findSessionForTouch(ownerSessionId: string): Promise<SessionTouchRecord | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: ownerSessionId },
      select: {
        userId: true,
        createdAt: true,
        expiresAt: true,
        user: { select: { institutionId: true } },
      },
    });
    if (!session?.user.institutionId) return null;
    return {
      userId: session.userId,
      institutionId: session.user.institutionId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  public async findSessionIdentity(ownerSessionId: string): Promise<SessionIdentityRecord | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: ownerSessionId },
      select: { userId: true, user: { select: { institutionId: true } } },
    });
    if (!session?.user.institutionId) return null;
    return { userId: session.userId, institutionId: session.user.institutionId };
  }

  public async listActiveGameOwnerSessionIds(): Promise<readonly string[]> {
    const sessions = await this.prisma.gameSession.findMany({
      where: { status: { in: ['BINDING', 'COUNTDOWN', 'PLAYING', 'PAUSED'] } },
      select: { ownerSessionId: true },
      distinct: ['ownerSessionId'],
    });
    return sessions.map(({ ownerSessionId }) => ownerSessionId);
  }

  public async readLastActivity(ownerSessionId: string): Promise<string | null> {
    return this.redis.get(activityKey(ownerSessionId));
  }

  public async initializeLastActivity(
    ownerSessionId: string,
    timestamp: number,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.set(activityKey(ownerSessionId), String(timestamp), 'PX', ttlMs, 'NX');
  }

  public async writeLastActivity(
    ownerSessionId: string,
    timestamp: number,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.set(activityKey(ownerSessionId), String(timestamp), 'PX', ttlMs);
  }

  public async deleteLastActivity(ownerSessionId: string): Promise<void> {
    await this.redis.del(activityKey(ownerSessionId));
  }

  public async acquireExpiryLock(ownerSessionId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(expiryLockKey(ownerSessionId), '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  public async releaseExpiryLock(ownerSessionId: string): Promise<void> {
    await this.redis.del(expiryLockKey(ownerSessionId));
  }

  public async deleteSession(ownerSessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: ownerSessionId } });
  }
}
