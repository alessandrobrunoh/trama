// Projects other workspaces share with the signed-in person (they are a guest there), and where
// that person chose to show them. A placement is personal: it grants nobody access and only the
// person who made it sees it. A project with no placement sits under "Shared with me"; a placement
// without a workspace hides it from there.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { ID, SharedProject } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { SessionStore } from '../session/session.store';
import { TramaStore } from './trama.store';

@Injectable({ providedIn: 'root' })
export class SharedProjectsStore {
  private readonly api = inject(ApiClient);
  private readonly session = inject(SessionStore);
  private readonly trama = inject(TramaStore);
  private readonly notifier = inject(Notifier);

  readonly items = signal<readonly SharedProject[]>([]);

  /** Shared projects the person has not placed or hidden: the "Shared with me" section. */
  readonly unplaced = computed(() => this.items().filter((p) => !p.placement));

  /** Shared projects shown in the open workspace, in the order chosen there. */
  readonly placedHere = computed(() => {
    const id = this.trama.workspace()?.id;
    if (!id) return [];
    return this.items()
      .filter((p) => p.placement?.workspaceId === id)
      .sort((a, b) => (a.placement?.position ?? 0) - (b.placement?.position ?? 0));
  });

  /** Whether the person is a guest anywhere, which is what makes the workspace switcher appear. */
  readonly any = computed(() => this.items().length > 0);

  constructor() {
    effect(() => {
      const user = this.session.user();
      // A workspace switch re-reads the list: access may have changed since it was loaded.
      this.trama.slug();
      untracked(() => {
        if (user) void this.load();
        else this.items.set([]);
      });
    });
  }

  async load(): Promise<void> {
    try {
      this.items.set(await this.api.shared.list());
    } catch {
      /* the section is a convenience; the app works without it */
    }
  }

  /** Show the project in one of my workspaces. */
  place(projectId: ID, workspaceId: ID): Promise<boolean> {
    return this.change(projectId, 'show the project there', (p) => ({
      ...p,
      placement: { projectId, workspaceId, position: p.placement?.position ?? Number.MAX_SAFE_INTEGER },
    }), () => this.api.shared.place(projectId, workspaceId));
  }

  /** Hide it from Shared with me. */
  hide(projectId: ID): Promise<boolean> {
    return this.change(projectId, 'hide the project', (p) => ({
      ...p,
      placement: { projectId, workspaceId: null, position: p.placement?.position ?? 0 },
    }), () => this.api.shared.hide(projectId));
  }

  /** Back to Shared with me. */
  clear(projectId: ID): Promise<boolean> {
    return this.change(projectId, 'move the project back', (p) => ({ ...p, placement: undefined }), () =>
      this.api.shared.clear(projectId),
    );
  }

  /** Give up access to the project. It disappears from the list for good. */
  async leave(projectId: ID): Promise<boolean> {
    const before = this.items();
    this.items.set(before.filter((p) => p.id !== projectId));
    try {
      await this.api.shared.leave(projectId);
      return true;
    } catch (e) {
      this.items.set(before);
      this.fail('leave the project', e);
      return false;
    }
  }

  /** Optimistic update of one project, rolled back when the server refuses. */
  private async change(
    projectId: ID,
    verb: string,
    next: (project: SharedProject) => SharedProject,
    call: () => Promise<unknown>,
  ): Promise<boolean> {
    const before = this.items();
    this.items.set(before.map((p) => (p.id === projectId ? next(p) : p)));
    try {
      await call();
      // The server decides the position of a new placement.
      void this.load();
      return true;
    } catch (e) {
      this.items.set(before);
      this.fail(verb, e);
      return false;
    }
  }

  private fail(verb: string, e: unknown): void {
    const err = ApiError.from(e);
    if (!err.isForbidden) this.notifier.error(`Could not ${verb}`, { description: err.message });
  }
}
