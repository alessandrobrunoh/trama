import { Subject, filter, firstValueFrom, take, timeout } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import type { PublishedEvent } from './events.service.js';
import { EventsController } from './events.controller.js';

describe('EventsController stream visibility', () => {
  it('drops hidden live subjects before writing SSE messages', async () => {
    const source = new Subject<PublishedEvent>();
    const visibility = {
      isLiveVisible: vi.fn(
        async (_workspaceId, _event, _access, subject) =>
          subject?.id === 'iss_visible',
      ),
    };
    const controller = new EventsController(
      { stream$: source.asObservable() } as never,
      visibility as never,
      { isStillValid: vi.fn(async () => true) } as never,
      {} as never,
    );
    const ctx = {
      workspace: { id: 'ws_1' },
      userId: 'usr_1',
      access: {
        projects: { all: false, projectIds: ['pr_1'] },
        includeUnassigned: false,
        grants: [],
      },
    } as unknown as WorkspaceContext;
    const auth = {} as AuthInfo;
    const received = firstValueFrom(
      controller.stream(ctx, auth).pipe(
        filter(
          (message) => !!(message.data as { id?: string } | undefined)?.id,
        ),
        take(1),
        timeout(1_000),
      ),
    );

    source.next({
      workspaceId: 'ws_1',
      subject: { type: 'issue', id: 'iss_hidden' },
      event: {
        type: 'created',
        entity: 'issue',
        id: 'iss_hidden',
        at: new Date().toISOString(),
      },
    });
    source.next({
      workspaceId: 'ws_1',
      subject: { type: 'issue', id: 'iss_visible' },
      event: {
        type: 'created',
        entity: 'issue',
        id: 'iss_visible',
        at: new Date().toISOString(),
      },
    });

    await expect(received).resolves.toMatchObject({
      data: { id: 'iss_visible' },
    });
    expect(visibility.isLiveVisible).toHaveBeenCalledTimes(2);
  });
});
