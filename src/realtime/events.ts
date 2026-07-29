import type { Redis } from 'ioredis';
import { AppServerMessageSchema, type AppServerMessage } from '../schemas/index.js';

const EVENT_TTL_SECONDS = 3_600;
const MAX_REPLAY_EVENTS = 256;

type Listener = (message: AppServerMessage) => void;

export class RealtimeEventStore {
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(private readonly redis: Redis) {}

  async publish(
    scope: 'setup' | 'session',
    id: string,
    message: unknown,
  ): Promise<AppServerMessage> {
    const key = `jalin:realtime:${scope}:${id}`;
    const sequence = await this.redis.incr(`${key}:sequence`);
    const parsed = AppServerMessageSchema.parse({ ...(message as object), sequence });
    const encoded = JSON.stringify(parsed);
    const transaction = this.redis.multi();
    transaction.rpush(`${key}:events`, encoded);
    transaction.ltrim(`${key}:events`, -MAX_REPLAY_EVENTS, -1);
    transaction.expire(`${key}:events`, EVENT_TTL_SECONDS);
    transaction.expire(`${key}:sequence`, EVENT_TTL_SECONDS);
    transaction.set(`${key}:snapshot`, encoded, 'EX', EVENT_TTL_SECONDS);
    await transaction.exec();
    for (const listener of this.#listeners.get(key) ?? []) listener(parsed);
    return parsed;
  }

  async replay(
    scope: 'setup' | 'session',
    id: string,
    after = 0,
  ): Promise<readonly AppServerMessage[]> {
    const key = `jalin:realtime:${scope}:${id}`;
    const encoded = await this.redis.lrange(`${key}:events`, 0, -1);
    const parsed: AppServerMessage[] = [];
    for (const entry of encoded) {
      try {
        const message = AppServerMessageSchema.parse(JSON.parse(entry));
        if (message.sequence > after) parsed.push(message);
      } catch {
        // Corrupt transient replay entries are skipped; the validated current snapshot remains available.
      }
    }
    if (parsed.length > 0) return parsed;
    const snapshot = await this.redis.get(`${key}:snapshot`);
    if (!snapshot) return [];
    try {
      const message = AppServerMessageSchema.parse(JSON.parse(snapshot));
      return message.sequence > after ? [message] : [];
    } catch {
      return [];
    }
  }

  subscribe(scope: 'setup' | 'session', id: string, listener: Listener): () => void {
    const key = `jalin:realtime:${scope}:${id}`;
    const listeners = this.#listeners.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }
}
