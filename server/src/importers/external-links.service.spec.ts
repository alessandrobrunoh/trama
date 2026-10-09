import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalRef } from '../contracts/domain.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../integrations/http-client.js';
import type { IssuesService } from '../issues/issues.service.js';
import type { CredentialsService } from './credentials.service.js';
import { ExternalLinksService } from './external-links.service.js';

const actor = { type: 'user' as const, id: 'usr_me' };

class FakeHttp extends HttpClient {
  readonly calls: HttpRequest[] = [];
  constructor(private readonly answer: (req: HttpRequest) => Partial<HttpResponse>) {
    super();
  }
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    return { status: 200, headers: {}, json: null, ...this.answer(req) };
  }
}

const ghIssue = (state = 'open') => ({
  number: 12,
  html_url: 'https://github.com/Acme/API/issues/12',
  title: 'Crash',
  state,
  labels: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
});

function setup(http: HttpClient, creds: Partial<Record<'forHost', unknown>> = {}) {
  const forHost = vi.fn(async () => ({ token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', baseUrl: null }));
  const issues = {
    get: vi.fn(async () => ({ externalRef: { provider: 'github', id: 'acme/api#12', url: 'https://github.com/Acme/API/issues/12', origin: 'link' } as ExternalRef })),
    setExternalRef: vi.fn(async (_ws: string, _a: unknown, _k: string, ref: ExternalRef | null) => ({ externalRef: ref })),
    refreshExternalRef: vi.fn(async (_ws: string, _k: string, patch: object) => patch),
  };
  const service = new ExternalLinksService(http, { forHost, ...creds } as unknown as CredentialsService, issues as unknown as IssuesService);
  return { service, forHost, issues };
}

describe('ExternalLinksService', () => {
  it('reads the GitHub issue behind the URL and stores a link-origin reference with a lower-case id', async () => {
    const http = new FakeHttp(() => ({ json: ghIssue() }));
    const { service, forHost, issues } = setup(http);
    await service.link('ws_1', actor, 'BUG-1', 'https://github.com/Acme/API/issues/12?utm=x');
    expect(http.calls[0].url).toBe('https://api.github.com/repos/Acme/API/issues/12');
    expect(forHost).toHaveBeenCalledWith('ws_1', 'github', 'github.com');
    const ref = issues.setExternalRef.mock.calls[0][3] as ExternalRef;
    expect(ref).toMatchObject({ provider: 'github', id: 'acme/api#12', key: '#12', state: 'Open', stateType: 'open', origin: 'link' });
  });

  it('refuses a URL that is neither GitHub nor Linear without calling anything', async () => {
    const http = new FakeHttp(() => ({}));
    const { service, forHost } = setup(http);
    await expect(service.link('ws_1', actor, 'BUG-1', 'https://example.com/a/b')).rejects.toBeInstanceOf(BadRequestException);
    expect(forHost).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(0);
  });

  it('explains how to get access when an anonymous read of a private repository fails, without leaking anything', async () => {
    const http = new FakeHttp(() => ({ status: 404, json: { message: 'Not Found' } }));
    const { service } = setup(http, { forHost: vi.fn(async () => ({ token: null, baseUrl: null })) });
    const err = (await service.link('ws_1', actor, 'BUG-1', 'https://github.com/acme/private/issues/1').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('Settings → Import');
  });

  it('refreshes by the stored id and keeps the Trama status out of it', async () => {
    const http = new FakeHttp(() => ({ json: ghIssue('closed') }));
    const { service, issues } = setup(http);
    await service.refresh('ws_1', 'BUG-1');
    expect(http.calls[0].url).toBe('https://api.github.com/repos/acme/api/issues/12');
    expect(issues.refreshExternalRef).toHaveBeenCalledWith('ws_1', 'BUG-1', expect.objectContaining({ state: 'Closed', stateType: 'done' }));
    expect(issues.setExternalRef).not.toHaveBeenCalled();
  });

  it('does not refresh an issue that is not linked', async () => {
    const { service, issues } = setup(new FakeHttp(() => ({})));
    issues.get.mockResolvedValueOnce({ externalRef: undefined } as never);
    await expect(service.refresh('ws_1', 'BUG-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
