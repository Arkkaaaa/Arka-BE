import type { Logger } from '../../config/logger.js';
import type { AuthRepository } from './auth.repository.js';

const IDLE_TIMEOUT_MS = 15 * 60 * 1_000;
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 30_000;
const EXPIRY_LOCK_TTL_MS = 30_000;

export type RuntimeExpirer = (ownerSessionId: string) => Promise<void>;
export type SocketRevoker = (ownerSessionId: string) => Promise<void>;

export class SessionActivityService {
  #runtimeExpirer: RuntimeExpirer | null = null;
  #socketRevoker: SocketRevoker | null = null;
  #timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly repository: AuthRepository,
    private readonly logger: Logger,
  ) {}

  public attachRuntimeExpirer(expirer: RuntimeExpirer): void {
    this.#runtimeExpirer = expirer;
  }

  public attachSocketRevoker(revoker: SocketRevoker): void {
    this.#socketRevoker = revoker;
  }

  public async validate(
    ownerSessionId: string,
    userId: string,
    institutionId: string,
  ): Promise<boolean> {
    const session = await this.repository.findActiveSession(ownerSessionId, userId, institutionId);
    if (!session) return false;

    const now = Date.now();
    const absoluteExpiry = session.createdAt.getTime() + ABSOLUTE_TIMEOUT_MS;
    const providerExpiry = session.expiresAt.getTime();
    let lastActivity = Number(await this.repository.readLastActivity(ownerSessionId));
    if (!Number.isFinite(lastActivity)) {
      const initialActivity = session.createdAt.getTime();
      await this.repository.initializeLastActivity(
        ownerSessionId,
        initialActivity,
        Math.max(1, absoluteExpiry - now),
      );
      lastActivity = Number(
        (await this.repository.readLastActivity(ownerSessionId)) ?? initialActivity,
      );
    }

    if (now >= absoluteExpiry || now >= providerExpiry || now - lastActivity >= IDLE_TIMEOUT_MS) {
      void this.expire(ownerSessionId).catch((error: unknown) =>
        this.logger.error(
          { err: error, ownerSessionId },
          'Gagal mengakhiri sesi autentikasi kedaluwarsa',
        ),
      );
      return false;
    }
    return true;
  }

  public async touch(ownerSessionId: string): Promise<void> {
    const session = await this.repository.findSessionForTouch(ownerSessionId);
    if (!session || !(await this.validate(ownerSessionId, session.userId, session.institutionId))) {
      return;
    }

    const remaining =
      Math.min(session.createdAt.getTime() + ABSOLUTE_TIMEOUT_MS, session.expiresAt.getTime()) -
      Date.now();
    if (remaining > 0) {
      await this.repository.writeLastActivity(ownerSessionId, Date.now(), remaining);
    }
  }

  public async prepareRevocation(ownerSessionId: string): Promise<void> {
    if (!this.#runtimeExpirer) throw new Error('Runtime session expirer is not attached');
    if (!this.#socketRevoker) throw new Error('App socket revoker is not attached');
    await this.#socketRevoker(ownerSessionId);
    await this.#runtimeExpirer(ownerSessionId);
    await this.repository.deleteLastActivity(ownerSessionId);
  }

  public async expire(ownerSessionId: string): Promise<void> {
    if (!this.#runtimeExpirer) return;
    const acquired = await this.repository.acquireExpiryLock(ownerSessionId, EXPIRY_LOCK_TTL_MS);
    if (!acquired) return;

    try {
      await this.prepareRevocation(ownerSessionId);
      await this.repository.deleteSession(ownerSessionId);
    } catch (error) {
      this.logger.error(
        { err: error, ownerSessionId },
        'Gagal mengakhiri sesi autentikasi secara aman',
      );
      throw error;
    } finally {
      await this.repository.releaseExpiryLock(ownerSessionId);
    }
  }

  public start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.error({ err: error }, 'Pemeriksaan kedaluwarsa sesi gagal'),
      );
    }, SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  public stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  public async sweep(): Promise<void> {
    const ownerSessionIds = await this.repository.listActiveGameOwnerSessionIds();
    for (const ownerSessionId of ownerSessionIds) {
      const session = await this.repository.findSessionIdentity(ownerSessionId);
      if (!session) {
        if (this.#runtimeExpirer) await this.#runtimeExpirer(ownerSessionId);
        continue;
      }
      await this.validate(ownerSessionId, session.userId, session.institutionId);
    }
  }
}
