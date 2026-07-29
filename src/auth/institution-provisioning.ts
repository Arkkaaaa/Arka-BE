const MIN_INSTITUTION_NAME_LENGTH = 2;
const MAX_INSTITUTION_NAME_LENGTH = 120;

export class InstitutionNameError extends Error {
  public constructor() {
    super('institution_name_invalid');
    this.name = 'InstitutionNameError';
  }
}

function normalizeInstitutionName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function validateRegistrationInstitutionName(value: unknown): string {
  if (typeof value !== 'string') throw new InstitutionNameError();
  const normalized = normalizeInstitutionName(value);
  if (
    normalized.length < MIN_INSTITUTION_NAME_LENGTH ||
    normalized.length > MAX_INSTITUTION_NAME_LENGTH
  ) {
    throw new InstitutionNameError();
  }
  return normalized;
}

export function deriveInstitutionName(name: unknown, email: unknown): string {
  if (typeof name === 'string') {
    const normalizedName = normalizeInstitutionName(name);
    if (normalizedName.length >= MIN_INSTITUTION_NAME_LENGTH) {
      return normalizedName.slice(0, MAX_INSTITUTION_NAME_LENGTH);
    }
  }
  if (typeof email === 'string' && email.includes('@')) {
    const localPart = normalizeInstitutionName(email.split('@')[0]?.replace(/[._-]+/gu, ' ') ?? '');
    if (localPart.length >= MIN_INSTITUTION_NAME_LENGTH) {
      return localPart.slice(0, MAX_INSTITUTION_NAME_LENGTH);
    }
  }
  return 'Institusi Arka';
}

interface OrphanInstitutionStore {
  institution: {
    deleteMany(input: { where: { id: string; user: null } }): Promise<{ count: number }>;
  };
}

export async function cleanupOrphanInstitution(
  store: OrphanInstitutionStore,
  institutionId: string,
): Promise<void> {
  await store.institution.deleteMany({ where: { id: institutionId, user: null } });
}
