import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isUploadBytesRoute,
  normalizePermissions,
  requiredPermission,
} from './api-permissions.js';

describe('requiredPermission', () => {
  it('maps method + resource', () => {
    expect(requiredPermission('GET', '/api/w/:slug/tasks')).toBe(
      'tasks:read',
    );
    expect(requiredPermission('POST', '/api/w/:slug/tasks')).toBe(
      'tasks:write',
    );
    expect(requiredPermission('PATCH', '/api/w/:slug/tasks/:idOrKey')).toBe(
      'tasks:write',
    );
    expect(requiredPermission('DELETE', '/api/w/:slug/tasks/:idOrKey')).toBe(
      'tasks:delete',
    );
    expect(requiredPermission('POST', '/api/w/:slug/tasks/bulk')).toBe(
      'tasks:write',
    );
    expect(requiredPermission('POST', '/api/w/:slug/tasks/bulk-delete')).toBe(
      'tasks:delete',
    );
    expect(
      requiredPermission('GET', '/api/w/:slug/workstreams/:idOrKey/graph'),
    ).toBeNull();
    expect(
      requiredPermission('POST', '/api/w/:slug/workstreams/:idOrKey/criteria'),
    ).toBeNull();
    expect(
      requiredPermission(
        'GET',
        '/api/w/:slug/outgoing-webhooks/:id/deliveries',
      ),
    ).toBe('outgoing-webhooks:read');
    expect(requiredPermission('POST', '/api/w/:slug/releases')).toBeNull();
  });

  it('keeps the issue-first insights routes read-only', () => {
    expect(requiredPermission('GET', '/api/w/:slug/insights')).toBe('insights:read');
    expect(
      requiredPermission('GET', '/api/w/:slug/insights/signals/:id'),
    ).toBe('insights:read');
  });

  it('maps the workspace itself and its settings', () => {
    expect(requiredPermission('GET', '/api/w/:slug')).toBe('workspace:read');
    expect(requiredPermission('PATCH', '/api/w/:slug')).toBe('workspace:write');
    expect(requiredPermission('PATCH', '/api/w/:slug/settings')).toBe(
      'workspace:write',
    );
    expect(requiredPermission('DELETE', '/api/w/:slug')).toBe(
      'workspace:delete',
    );
  });

  it('maps imports to integrations and task external links to tasks', () => {
    expect(requiredPermission('GET', '/api/w/:slug/imports')).toBe(
      'integrations:read',
    );
    expect(requiredPermission('GET', '/api/w/:slug/imports/credentials')).toBe(
      'integrations:read',
    );
    expect(requiredPermission('POST', '/api/w/:slug/imports/preview')).toBe(
      'integrations:write',
    );
    expect(requiredPermission('POST', '/api/w/:slug/imports')).toBe(
      'integrations:write',
    );
    expect(requiredPermission('POST', '/api/w/:slug/imports/:id/cancel')).toBe(
      'integrations:write',
    );
    expect(
      requiredPermission('DELETE', '/api/w/:slug/imports/credentials/:id'),
    ).toBe('integrations:delete');
    expect(
      requiredPermission('POST', '/api/w/:slug/tasks/:idOrKey/external-ref'),
    ).toBe('tasks:write');
    expect(
      requiredPermission(
        'POST',
        '/api/w/:slug/tasks/:idOrKey/external-ref/refresh',
      ),
    ).toBe('tasks:write');
    expect(
      requiredPermission('DELETE', '/api/w/:slug/tasks/:idOrKey/external-ref'),
    ).toBe('tasks:delete');
  });

  it('maps nested artifact routes to artifacts:*, not the parent resource', () => {
    const table: [string, string, string][] = [
      ['GET', '/api/w/:slug/tasks/:idOrKey/artifacts', 'artifacts:read'],
      ['POST', '/api/w/:slug/tasks/:idOrKey/artifacts', 'artifacts:write'],
      ['GET', '/api/w/:slug/artifacts/:id', 'artifacts:read'],
      ['DELETE', '/api/w/:slug/artifacts/:id', 'artifacts:delete'],
      [
        'POST',
        '/api/w/:slug/tasks/:idOrKey/artifacts/upload',
        'artifacts:write',
      ],
    ];
    for (const [method, route, expected] of table)
      expect(requiredPermission(method, route), `${method} ${route}`).toBe(
        expected,
      );
    expect(requiredPermission('GET', '/api/w/:slug/uploads/:id')).toBeNull();
    expect(isUploadBytesRoute('/api/w/:slug/uploads/:id')).toBe(true);
    expect(
      isUploadBytesRoute('/api/w/:slug/tasks/:idOrKey/artifacts/upload'),
    ).toBe(false);
  });

  it('no longer knows the removed documents resource', () => {
    expect(requiredPermission('GET', '/api/w/:slug/documents')).toBeNull();
    expect(normalizePermissions(['documents:write'])).toEqual([]);
  });

  it('keeps the other nested routes under their parent resource', () => {
    const table: [string, string, string][] = [
      ['POST', '/api/w/:slug/tasks/:idOrKey/link', 'tasks:write'],
    ];
    for (const [method, route, expected] of table)
      expect(requiredPermission(method, route), `${method} ${route}`).toBe(
        expected,
      );
  });

  it('fails closed on a nested sub-resource that is in the catalog but not mapped', () => {
    expect(
      requiredPermission('GET', '/api/w/:slug/tasks/:idOrKey/comments'),
    ).toBeNull();
    expect(
      requiredPermission('POST', '/api/w/:slug/workstreams/:idOrKey/issues'),
    ).toBeNull();
    expect(
      requiredPermission('DELETE', '/api/w/:slug/projects/:id/tokens/:tokenId'),
    ).toBeNull();
  });

  it('fails closed outside the catalog', () => {
    expect(requiredPermission('GET', '/api/workspaces')).toBeNull();
    expect(requiredPermission('GET', '/api/auth/me')).toBeNull();
    expect(requiredPermission('POST', '/api/invites/:token/accept')).toBeNull();
    expect(
      requiredPermission('PATCH', '/api/me/notification-settings'),
    ).toBeNull();
    expect(requiredPermission('PUT', '/api/me/push/subscription')).toBeNull();
    expect(requiredPermission('POST', '/api/w/:slug/ai/chat')).toBeNull();
    expect(requiredPermission('GET', '/api/w/:slug/something-new')).toBeNull();
    // actions a resource does not offer
    expect(requiredPermission('POST', '/api/w/:slug/search')).toBeNull();
    expect(
      requiredPermission('DELETE', '/api/w/:slug/attention/:id'),
    ).toBeNull();
  });
});

describe('normalizePermissions', () => {
  it('drops unknown values, dedupes and adds the implied read', () => {
    expect(
      normalizePermissions([
        'tasks:write',
        'tasks:write',
        'bogus:read',
        'tasks:fly',
        'teams:read',
        'issues:read',
      ]),
    ).toEqual(['tasks:read', 'tasks:write']);
  });
});

describe('MCP tool catalog', () => {
  const tools = JSON.parse(
    readFileSync(
      new URL('../../../mcp/src/tools.json', import.meta.url),
      'utf8',
    ),
  ) as {
    name: string;
    method: string;
    path: string;
    permission: string;
  }[];

  it("declares exactly the permission the API derives from each tool's route", () => {
    expect(tools.length).toBeGreaterThan(50);
    for (const t of tools) {
      const removed = /^\/(teams|customers|customer-|decisions|releases|input-requests|repositories|intake)/.test(t.path);
      if (removed) continue;
      const path = t.path.replace(/^\/issues/, '/tasks');
      const route = `/api/w/:slug${path.replace(/\{(\w+)\}/g, ':$1')}`;
      const permission = t.permission.replace(/^issues:/, 'tasks:');
      expect(
        requiredPermission(t.method, route),
        `${t.name} (${t.method} ${t.path})`,
      ).toBe(permission);
    }
  });
});
