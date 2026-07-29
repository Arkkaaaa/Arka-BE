import { describe, expect, it } from 'vitest';
import { buildAuthCapabilities } from './capabilities.js';

describe('auth capabilities', () => {
  it('disables Google when OAuth credentials are not configured', () => {
    expect(buildAuthCapabilities({ googleOAuth: null })).toEqual({
      emailPassword: true,
      registration: true,
      socialProviders: { google: false },
    });
  });

  it('enables Google without exposing configured credentials', () => {
    const capabilities = buildAuthCapabilities({
      googleOAuth: {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      },
    });

    expect(capabilities).toEqual({
      emailPassword: true,
      registration: true,
      socialProviders: { google: true },
    });
  });
});
