import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizePermissions, requiredPermission } from './api-permissions.js';

describe('requiredPermission', () => {
  it('maps method + resource', () => {
    expect(requiredPermission('GET', '/api/w/:slug/issues')).toBe('issues:read');
    expect(requiredPermission('POST', '/api/w/:slug/issues')).toBe('issues:write');
    expect(requiredPermission('PATCH', '/api/w/:slug/issues/:idOrKey')).toBe('issues:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/issues/:idOrKey')).toBe('issues:delete');
    expect(requiredPermission('POST', '/api/w/:slug/issues/bulk')).toBe('issues:write');
    expect(requiredPermission('POST', '/api/w/:slug/issues/bulk-delete')).toBe('issues:delete');
    expect(requiredPermission('GET', '/api/w/:slug/workstreams/:idOrKey/graph')).toBe('workstreams:read');
    expect(requiredPermission('POST', '/api/w/:slug/workstreams/:idOrKey/criteria')).toBe('workstreams:write');
    expect(requiredPermission('GET', '/api/w/:slug/outgoing-webhooks/:id/deliveries')).toBe('outgoing-webhooks:read');
  });

  it('maps insights, including the per-signal drill-down, to insights:read', () => {
    expect(requiredPermission('GET', '/api/w/:slug/insights')).toBe('insights:read');
    expect(requiredPermission('GET', '/api/w/:slug/insights/signals/:id')).toBe('insights:read');
  });

  it('maps the workspace itself and its settings', () => {
    expect(requiredPermission('GET', '/api/w/:slug')).toBe('workspace:read');
    expect(requiredPermission('PATCH', '/api/w/:slug')).toBe('workspace:write');
    expect(requiredPermission('PATCH', '/api/w/:slug/settings')).toBe('workspace:write');
    expect(requiredPermission('DELETE', '/api/w/:slug')).toBe('workspace:delete');
  });

  it('maps the customer-request inbox to customers and its sources to integrations', () => {
    expect(requiredPermission('GET', '/api/w/:slug/customer-intake')).toBe('customers:read');
    expect(requiredPermission('POST', '/api/w/:slug/customer-intake/:id/link')).toBe('customers:write');
    expect(requiredPermission('GET', '/api/w/:slug/intake-sources')).toBe('integrations:read');
    expect(requiredPermission('POST', '/api/w/:slug/intake-sources/:id/rotate-secret')).toBe('integrations:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/intake-sources/:id')).toBe('integrations:delete');
  });

  it('maps imports to integrations (admin) and issue external links to issues', () => {
    expect(requiredPermission('GET', '/api/w/:slug/imports')).toBe('integrations:read');
    expect(requiredPermission('GET', '/api/w/:slug/imports/credentials')).toBe('integrations:read');
    expect(requiredPermission('POST', '/api/w/:slug/imports/preview')).toBe('integrations:write');
    expect(requiredPermission('POST', '/api/w/:slug/imports')).toBe('integrations:write');
    expect(requiredPermission('POST', '/api/w/:slug/imports/:id/cancel')).toBe('integrations:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/imports/credentials/:id')).toBe('integrations:delete');
    expect(requiredPermission('POST', '/api/w/:slug/issues/:idOrKey/external-ref')).toBe('issues:write');
    expect(requiredPermission('POST', '/api/w/:slug/issues/:idOrKey/external-ref/refresh')).toBe('issues:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/issues/:idOrKey/external-ref')).toBe('issues:delete');
  });

  it('maps customer tiers to workspace settings and the flat request list to customers', () => {
    expect(requiredPermission('POST', '/api/w/:slug/customer-tiers')).toBe('workspace:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/customer-tiers/:id')).toBe('workspace:delete');
    expect(requiredPermission('GET', '/api/w/:slug/customer-requests')).toBe('customers:read');
    expect(requiredPermission('PATCH', '/api/w/:slug/customers/:id/requests/:requestId')).toBe('customers:write');
  });

  it('gives decision verdicts their own permission', () => {
    expect(requiredPermission('POST', '/api/w/:slug/decisions/:idOrKey/accept')).toBe('decisions:accept');
    expect(requiredPermission('POST', '/api/w/:slug/decisions/:idOrKey/supersede')).toBe('decisions:accept');
    expect(requiredPermission('PATCH', '/api/w/:slug/decisions/:idOrKey')).toBe('decisions:write');
  });

  it('maps nested artifact routes to artifacts:*, not the parent resource', () => {
    const table: [string, string, string][] = [
      ['GET', '/api/w/:slug/issues/:idOrKey/artifacts', 'artifacts:read'],
      ['POST', '/api/w/:slug/issues/:idOrKey/artifacts', 'artifacts:write'],
      ['GET', '/api/w/:slug/workstreams/:idOrKey/artifacts', 'artifacts:read'],
      ['POST', '/api/w/:slug/workstreams/:idOrKey/artifacts', 'artifacts:write'],
      ['GET', '/api/w/:slug/projects/:id/artifacts', 'artifacts:read'],
      ['POST', '/api/w/:slug/projects/:id/artifacts', 'artifacts:write'],
      ['GET', '/api/w/:slug/artifacts/:id', 'artifacts:read'],
      ['DELETE', '/api/w/:slug/artifacts/:id', 'artifacts:delete'],
    ];
    for (const [method, route, expected] of table) expect(requiredPermission(method, route), `${method} ${route}`).toBe(expected);
  });

  it('maps documents to documents:*, revisions included; attaching needs artifacts:write', () => {
    const table: [string, string, string][] = [
      ['GET', '/api/w/:slug/documents', 'documents:read'],
      ['GET', '/api/w/:slug/documents/:id/revisions', 'documents:read'],
      ['POST', '/api/w/:slug/documents', 'documents:write'],
      ['PATCH', '/api/w/:slug/documents/:id', 'documents:write'],
      ['POST', '/api/w/:slug/documents/:id/attach', 'artifacts:write'],
      ['POST', '/api/w/:slug/documents/:id/detach', 'artifacts:write'],
      ['POST', '/api/w/:slug/documents/:id/revisions/:version/restore', 'documents:write'],
      ['DELETE', '/api/w/:slug/documents/:id', 'documents:delete'],
    ];
    for (const [method, route, expected] of table) expect(requiredPermission(method, route), `${method} ${route}`).toBe(expected);
    expect(normalizePermissions(['documents:write'])).toEqual(['documents:read', 'documents:write']);
  });

  it('keeps the other nested routes under their parent resource', () => {
    const table: [string, string, string][] = [
      ['POST', '/api/w/:slug/projects/:projectId/updates', 'projects:write'],
      ['DELETE', '/api/w/:slug/projects/:projectId/updates/:id', 'projects:delete'],
      ['GET', '/api/w/:slug/projects/:id/context', 'projects:read'],
      ['GET', '/api/w/:slug/workstreams/:idOrKey/graph', 'workstreams:read'],
      ['GET', '/api/w/:slug/workstreams/:idOrKey/context', 'workstreams:read'],
      ['PATCH', '/api/w/:slug/workstreams/:idOrKey/criteria/:criterionId', 'workstreams:write'],
      ['POST', '/api/w/:slug/issues/:idOrKey/link', 'issues:write'],
      ['POST', '/api/w/:slug/input-requests/:id/answer', 'input-requests:write'],
    ];
    for (const [method, route, expected] of table) expect(requiredPermission(method, route), `${method} ${route}`).toBe(expected);
  });

  it('fails closed on a nested sub-resource that is in the catalog but not mapped', () => {
    expect(requiredPermission('GET', '/api/w/:slug/issues/:idOrKey/comments')).toBeNull();
    expect(requiredPermission('POST', '/api/w/:slug/workstreams/:idOrKey/issues')).toBeNull();
    expect(requiredPermission('DELETE', '/api/w/:slug/projects/:id/tokens/:tokenId')).toBeNull();
  });

  it('fails closed outside the catalog', () => {
    expect(requiredPermission('GET', '/api/workspaces')).toBeNull();
    expect(requiredPermission('GET', '/api/auth/me')).toBeNull();
    expect(requiredPermission('POST', '/api/invites/:token/accept')).toBeNull();
    expect(requiredPermission('PATCH', '/api/me/notification-settings')).toBeNull();
    expect(requiredPermission('PUT', '/api/me/push/subscription')).toBeNull();
    expect(requiredPermission('POST', '/api/w/:slug/ai/chat')).toBeNull();
    expect(requiredPermission('GET', '/api/w/:slug/something-new')).toBeNull();
    // actions a resource does not offer
    expect(requiredPermission('POST', '/api/w/:slug/search')).toBeNull();
    expect(requiredPermission('DELETE', '/api/w/:slug/attention/:id')).toBeNull();
  });
});

describe('normalizePermissions', () => {
  it('drops unknown values, dedupes and adds the implied read', () => {
    expect(normalizePermissions(['issues:write', 'issues:write', 'bogus:read', 'issues:fly', 'teams:read'])).toEqual([
      'issues:read',
      'issues:write',
      'teams:read',
    ]);
    expect(normalizePermissions(['decisions:accept'])).toEqual(['decisions:read', 'decisions:accept']);
  });
});

describe('MCP tool catalog', () => {
  const tools = JSON.parse(readFileSync(new URL('../../../mcp/src/tools.json', import.meta.url), 'utf8')) as {
    name: string;
    method: string;
    path: string;
    permission: string;
  }[];

  it('declares exactly the permission the API derives from each tool\'s route', () => {
    expect(tools.length).toBeGreaterThan(80);
    for (const t of tools) {
      const route = `/api/w/:slug${t.path.replace(/\{(\w+)\}/g, ':$1')}`;
      expect(requiredPermission(t.method, route), `${t.name} (${t.method} ${t.path})`).toBe(t.permission);
    }
  });
});
