import { describe, expect, it, vi } from 'vitest';
import {
  cleanupOrphanInstitution,
  deriveInstitutionName,
  validateRegistrationInstitutionName,
} from './institution-provisioning.js';

describe('institution provisioning', () => {
  it('normalizes a valid registration institution name', () => {
    expect(validateRegistrationInstitutionName('  RS   Harapan  ')).toBe('RS Harapan');
  });

  it('rejects registration institution names outside sane bounds', () => {
    expect(() => validateRegistrationInstitutionName('A')).toThrow('institution_name_invalid');
    expect(() => validateRegistrationInstitutionName('A'.repeat(121))).toThrow(
      'institution_name_invalid',
    );
  });

  it('derives a safe institution name for social first sign-in', () => {
    expect(deriveInstitutionName('  Klinik   Sehat  ', 'admin@example.org')).toBe('Klinik Sehat');
    expect(deriveInstitutionName('', 'care.team@example.org')).toBe('care team');
    expect(deriveInstitutionName('', 'invalid-email')).toBe('Institusi Arka');
  });

  it('deletes only an unbound institution during cleanup', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });

    await cleanupOrphanInstitution({ institution: { deleteMany } }, 'institution-1');

    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: 'institution-1', user: null },
    });
  });
});
