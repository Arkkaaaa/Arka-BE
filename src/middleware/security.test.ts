import { describe, expect, it, vi } from 'vitest';
import { csrfToken, protectAuthMutation } from './security.js';

const SECRET = 'test-only-secret-with-at-least-32-characters';

function invoke(
  middleware: ReturnType<typeof protectAuthMutation>,
  request: Record<string, unknown>,
): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  middleware(request as never, {} as never, resolve as never);
  return promise;
}

describe('protectAuthMutation', () => {
  it('prepares active runtime state for revocation before sign-out continues', async () => {
    const prepareRevocation = vi.fn(() => Promise.resolve());
    const auth = {
      handler: vi.fn(),
      api: {
        getSession: vi.fn(() =>
          Promise.resolve({
            session: { id: 'session-1', expiresAt: new Date('2026-07-27T00:00:00.000Z') },
            user: {
              id: 'user-1',
              email: 'caregiver@example.test',
              name: 'Caregiver',
              institutionId: 'institution-1',
            },
          }),
        ),
      },
    };
    const request = {
      method: 'POST',
      path: '/sign-out',
      headers: {},
      get: (name: string) =>
        name.toLowerCase() === 'x-csrf-token' ? csrfToken('session-1', SECRET) : undefined,
    };

    const result = await invoke(protectAuthMutation(auth, SECRET, prepareRevocation), request);

    expect(result).toBeUndefined();
    expect(prepareRevocation).toHaveBeenCalledOnce();
    expect(prepareRevocation).toHaveBeenCalledWith('session-1');
  });
});
