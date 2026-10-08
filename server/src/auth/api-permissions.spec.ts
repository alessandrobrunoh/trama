import { describe, expect, it } from 'vitest';
import { normalizePermissions, requiredPermission } from './api-permissions.js';

describe('requiredPermission', () => {
  it('maps method + resource', () => {
    expect(requiredPermission('GET', '/api/w/:slug/issues')).toBe('issues:read');
    expect(requiredPermission('POST', '/api/w/:slug/issues')).toBe('issues:write');
    expect(requiredPermission('PATCH', '/api/w/:slug/issues/:idOrKey')).toBe('issues:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/issues/:idOrKey')).toBe('issues:delete');
    expect(requiredPermission('GET', '/api/w/:slug/workstreams/:idOrKey/graph')).toBe('workstreams:read');
    expect(requiredPermission('POST', '/api/w/:slug/workstreams/:idOrKey/criteria')).toBe('workstreams:write');
    expect(requiredPermission('GET', '/api/w/:slug/outgoing-webhooks/:id/deliveries')).toBe('outgoing-webhooks:read');
  });

  it('maps the workspace itself and its settings', () => {
    expect(requiredPermission('GET', '/api/w/:slug')).toBe('workspace:read');
    expect(requiredPermission('PATCH', '/api/w/:slug')).toBe('workspace:write');
    expect(requiredPermission('PATCH', '/api/w/:slug/settings')).toBe('workspace:write');
    expect(requiredPermission('DELETE', '/api/w/:slug')).toBe('workspace:delete');
  });

  it('gives decision verdicts their own permission', () => {
    expect(requiredPermission('POST', '/api/w/:slug/decisions/:idOrKey/accept')).toBe('decisions:accept');
    expect(requiredPermission('POST', '/api/w/:slug/decisions/:idOrKey/supersede')).toBe('decisions:accept');
    expect(requiredPermission('PATCH', '/api/w/:slug/decisions/:idOrKey')).toBe('decisions:write');
  });

  it('fails closed outside the catalog', () => {
    expect(requiredPermission('GET', '/api/workspaces')).toBeNull();
    expect(requiredPermission('GET', '/api/auth/me')).toBeNull();
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
