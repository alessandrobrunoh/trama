import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationConnectionEntity } from '../database/entities/index.js';
import { IntegrationsService } from './integrations.service.js';
import { SecretsService } from './secrets.service.js';

function setup() {
  const secrets = new SecretsService();
  const row = Object.assign(new IntegrationConnectionEntity(), {
    id: 'ic_1',
    workspaceId: 'w1',
    provider: 'github',
    baseUrl: 'https://ghe.example.com',
    account: 'octo',
    status: 'connected',
    lastError: null,
    config: {},
    secret: secrets.encrypt('stored-token', 'ic_1:secret'),
  });
  const seen: { url: string; auth?: string }[] = [];
  const http = {
    request: vi.fn(async (req: { url: string; headers?: Record<string, string> }) => {
      seen.push({ url: req.url, auth: req.headers?.['Authorization'] ?? req.headers?.['authorization'] });
      return { status: 200, headers: {}, json: { login: 'octo' } };
    }),
  };
  const repo = { findOneBy: async () => row, save: async (x: unknown) => x };
  const events = { publish: vi.fn() };
  const service = new IntegrationsService(http as never, secrets, events as never, {} as never, repo as never, {} as never);
  return { service, row, http, seen };
}

describe('IntegrationsService.update base URL change', () => {
  it('does not send the stored token to a new host unless the token is supplied again', async () => {
    const { service, row, http } = setup();
    await expect(service.update('w1', 'ic_1', { baseUrl: 'https://attacker.example.net' }, 'http://x')).rejects.toBeInstanceOf(BadRequestException);
    expect(http.request).not.toHaveBeenCalled();
    expect(row.baseUrl).toBe('https://ghe.example.com');
  });

  it('accepts a new host together with a fresh token, and an unchanged host without one', async () => {
    const { service, row } = setup();
    await service.update('w1', 'ic_1', { baseUrl: 'https://ghe.example.org', token: 'fresh' }, 'http://x');
    expect(row.baseUrl).toBe('https://ghe.example.org');
    await service.update('w1', 'ic_1', { baseUrl: 'https://ghe.example.org' }, 'http://x');
    expect(row.baseUrl).toBe('https://ghe.example.org');
  });
});

describe('IntegrationsService base URL SSRF guard', () => {
  it.each(['http://169.254.169.254', 'http://127.0.0.1:8080', 'http://localhost', 'https://10.0.0.5/gitlab', 'http://[::1]'])(
    'rejects %s with a 400 before contacting it',
    async (baseUrl) => {
      const { service, http } = setup();
      await expect(service.update('w1', 'ic_1', { baseUrl, token: 'fresh' }, 'http://x')).rejects.toThrow(/Invalid baseUrl: .*not allowed/);
      await expect(service.create('w1', { type: 'user', id: 'u' } as never, { provider: 'gitlab', token: 't', baseUrl }, 'http://x')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(http.request).not.toHaveBeenCalled();
    },
  );
});
