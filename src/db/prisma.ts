import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { jalinPrisma?: PrismaClient };

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export function getPrisma(env: Env): PrismaClient {
  if (!globalForPrisma.jalinPrisma) globalForPrisma.jalinPrisma = createPrisma(env.DATABASE_URL);
  return globalForPrisma.jalinPrisma;
}
