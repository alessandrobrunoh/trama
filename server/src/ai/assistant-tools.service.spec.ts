import { describe, expect, it } from 'vitest';
import { requiredPermission } from '../auth/api-permissions.js';
import { API_PERMISSIONS } from '../contracts/domain.js';
import { ASSISTANT_PERMISSIONS, compactResult } from './assistant-tools.service.js';

describe('assistant token scope', () => {
  it('cannot rewrite workspace configuration, manage agents or touch access management', () => {
    for (const p of [
      'workspace:write',
      'workspace:delete',
      'agents:write',
      'agents:delete',
      'tokens:read',
      'tokens:write',
      'members:write',
      'integrations:write',
      'outgoing-webhooks:write',
    ] as const) {
      expect(ASSISTANT_PERMISSIONS, p).not.toContain(p);
    }
  });

  it('keeps what the assistant needs to read and manage work items', () => {
    for (const p of [
      'workspace:read',
      'agents:read',
      'issues:write',
      'workstreams:write',
      'projects:write',
      'artifacts:write',
      'comments:write',
      'decisions:write',
      'input-requests:write',
      'search:read',
    ] as const) {
      expect(ASSISTANT_PERMISSIONS, p).toContain(p);
    }
  });

  it('cannot call the routes that hold the permission policy or the workspace identity', () => {
    for (const [method, route] of [
      ['PATCH', '/api/w/:slug/settings'],
      ['PATCH', '/api/w/:slug'],
      ['POST', '/api/w/:slug/labels'],
      ['POST', '/api/w/:slug/customer-tiers'],
      ['POST', '/api/w/:slug/agents'],
      ['PATCH', '/api/w/:slug/agents/:id'],
    ] as const) {
      const needed = requiredPermission(method, route);
      expect(needed, `${method} ${route}`).not.toBeNull();
      expect(ASSISTANT_PERMISSIONS, `${method} ${route}`).not.toContain(needed);
    }
  });

  it('only lists permissions from the catalog', () => {
    for (const p of ASSISTANT_PERMISSIONS) expect(API_PERMISSIONS).toContain(p);
  });
});

describe('compactResult', () => {
  it('drops bulky fields from lists but leaves single records and non-JSON alone', () => {
    const list = JSON.stringify([
      { key: 'BUG-1', title: 'a', priority: 'high', body: 'x'.repeat(500), workspaceId: 'ws_1' },
      { key: 'BUG-2', title: 'b', priority: 'low', body: 'y' },
    ]);
    const out = compactResult(list);
    expect(out.startsWith('2 results:\n')).toBe(true);
    expect(JSON.parse(out.slice(out.indexOf('\n') + 1))).toEqual([
      { key: 'BUG-1', title: 'a', priority: 'high' },
      { key: 'BUG-2', title: 'b', priority: 'low' },
    ]);
    expect(compactResult('[]')).toBe('0 results:\n[]');
    expect(compactResult('[{"key":"A"}]')).toBe('1 result:\n[{"key":"A"}]');
    const one = JSON.stringify({ key: 'BUG-1', body: 'keep' });
    expect(compactResult(one)).toBe(one);
    expect(compactResult('# markdown')).toBe('# markdown');
  });
});
