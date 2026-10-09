import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AuthController } from '../auth/auth.controller.js';
import {
  REQUIRE_USER_KEY,
  SESSION_ONLY_KEY,
  type AuthInfo,
} from '../auth/request-context.js';
import { InviteLinksController } from '../invites/invites.controller.js';
import { NotificationSettingsController, PushController } from '../notifications/notifications.controller.js';
import { WorkspacesController } from './workspaces.controller.js';

const mine = [
  { id: 'ws_1', slug: 'one', role: 'owner' },
  { id: 'ws_2', slug: 'two', role: 'admin' },
];
const user = { id: 'u1' };
const session = { actor: { type: 'user', id: 'u1' }, user, method: 'session' } as unknown as AuthInfo;
const token = { actor: { type: 'user', id: 'u1' }, user, method: 'token', token: { workspaceId: 'ws_2', scope: 'admin' } } as unknown as AuthInfo;

describe('account routes and the token workspace', () => {
  it('GET /workspaces: a token only sees its own workspace, a session sees all', async () => {
    const controller = new WorkspacesController({ listMine: async () => mine } as never);
    expect(await controller.list(session)).toEqual(mine);
    expect(await controller.list(token)).toEqual([mine[1]]);
  });

  it('GET /auth/me: a token only learns about its own workspace', async () => {
    const controller = new AuthController({ workspacesOf: async () => mine } as never, {} as never);
    expect((await controller.me(session)).workspaces).toEqual(mine);
    expect((await controller.me(token)).workspaces).toEqual([mine[1]]);
  });

  it('creating workspaces, accepting invites and personal settings are session-only', () => {
    const marked = (target: object, key?: string): boolean =>
      key
        ? Reflect.getMetadata(SESSION_ONLY_KEY, (target as Record<string, object>)[key]) === true
        : Reflect.getMetadata(SESSION_ONLY_KEY, target.constructor) === true;
    expect(marked(WorkspacesController.prototype, 'create')).toBe(true);
    expect(marked(InviteLinksController.prototype, 'accept')).toBe(true);
    expect(Reflect.getMetadata(SESSION_ONLY_KEY, NotificationSettingsController)).toBe(true);
    expect(Reflect.getMetadata(SESSION_ONLY_KEY, PushController)).toBe(true);
    // listing stays reachable by tokens (it is filtered instead)
    expect(marked(WorkspacesController.prototype, 'list')).toBe(false);
    expect(Reflect.getMetadata(REQUIRE_USER_KEY, WorkspacesController.prototype.list)).toBe(true);
  });
});
