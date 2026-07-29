import { describe, expect, it } from 'vitest';
import { redactOperationalValue } from './logger.js';

describe('operational logger redaction', () => {
  it('redacts sensitive values in circular objects without recursing forever', () => {
    const value: Record<string, unknown> = { password: 'secret' };
    value['self'] = value;

    expect(redactOperationalValue(value)).toEqual({
      password: '[REDACTED]',
      self: '[Circular]',
    });
  });
});
