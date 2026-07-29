import { describe, expect, it, vi, type Mock } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRealtimeAttachment } from './index.js';

function dependencies(browserOrigins: readonly string[]) {
  return {
    env: { browserOrigins },
    logger: { warn: vi.fn() },
  } as never;
}

function request(origin?: string): IncomingMessage {
  return {
    method: 'GET',
    url: '/ws/app',
    headers: origin === undefined ? {} : { origin },
  } as IncomingMessage;
}

function socket(end: Mock = vi.fn()): Duplex & { end: Mock; destroyed: boolean } {
  return { destroyed: false, end } as unknown as Duplex & {
    end: Mock;
    destroyed: boolean;
  };
}

describe('RealtimeAttachment app upgrades', () => {
  it('delegates a permitted app origin to the authenticated gateway path', () => {
    const attachment = createRealtimeAttachment(dependencies(['https://app.jalin.test']));
    const handleUpgrade = vi.spyOn(attachment.appGateway, 'handleUpgrade').mockResolvedValue();
    const client = socket();

    expect(
      attachment.handleUpgrade(request('https://app.jalin.test'), client, Buffer.alloc(0)),
    ).toBe(true);
    expect(handleUpgrade).toHaveBeenCalledOnce();
    expect(handleUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/ws/app' }),
      client,
      expect.any(Buffer),
    );
  });

  it('rejects a disallowed app origin without invoking the gateway', () => {
    const attachment = createRealtimeAttachment(dependencies(['https://app.jalin.test']));
    const handleUpgrade = vi.spyOn(attachment.appGateway, 'handleUpgrade').mockResolvedValue();
    const end = vi.fn();
    const client = socket(end);

    expect(
      attachment.handleUpgrade(request('https://other.jalin.test'), client, Buffer.alloc(0)),
    ).toBe(true);
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith(
      'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
});
