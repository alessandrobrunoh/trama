// The written updates of the project being looked at. Loaded on demand, one project at a time: the project page
// needs them for the "N new" count on its tab, the Updates tab for the summary and the key events. It also keeps,
// per project, when this person last had the tab open (localStorage; without it every update counts as new).
import { Injectable, computed, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { LiveSync } from '../../core/sync/live-sync.service';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type {
  CreateProjectUpdateInput,
  ID,
  ProjectUpdate,
  UpdateProjectUpdateInput,
} from '../../core/contracts/domain';
import { Notifier } from '../../core/notify/notifier';
import { readJson, writeJson } from '../../core/stores/storage';
import { TramaStore } from '../../core/stores/trama.store';
import { latestUpdateAt, newUpdatesCount } from './project-updates-model';

const SEEN_KEY = 'trama.projectUpdatesSeen';

@Injectable({ providedIn: 'root' })
export class ProjectUpdatesStore {
  private readonly api = inject(ApiClient);
  private readonly trama = inject(TramaStore);
  private readonly notifier = inject(Notifier);

  /** The project the updates belong to. */
  readonly projectId = signal<ID | null>(null);
  /** Newest first. */
  readonly updates = signal<readonly ProjectUpdate[]>([]);
  readonly loading = signal(false);
  /** The list could not be read (older server, no access): the tab stays usable without it. */
  readonly failed = signal(false);

  private readonly seen = signal<Record<string, string | undefined>>(
    readJson<Record<string, string>>(SEEN_KEY) ?? {},
  );
  private readonly seenKey = computed(() => `${this.trama.slug() ?? ''}/${this.projectId() ?? ''}`);

  private readonly live = inject(LiveSync);

  constructor() {
    // Someone else posted, edited or deleted an update: read the list again.
    this.live.events$
      .pipe(filter((e) => e.entity === 'project_update'))
      .subscribe(() => {
        const id = this.projectId();
        if (id) void this.load(id);
      });
  }

  /** Updates by other people posted since this person last had the tab open. */
  readonly newCount = computed(() =>
    newUpdatesCount(this.updates(), this.seen()[this.seenKey()] ?? null, this.trama.me()?.id),
  );

  /** Loads (or reloads) the updates of a project. Another project's updates are dropped first. */
  async load(projectId: ID): Promise<void> {
    const slug = this.trama.slug();
    if (!slug) return;
    if (this.projectId() !== projectId) {
      this.projectId.set(projectId);
      this.updates.set([]);
    }
    this.loading.set(true);
    this.failed.set(false);
    try {
      const list = await this.api.projectUpdates.list(slug, projectId, { quiet: true });
      if (this.projectId() === projectId && this.trama.slug() === slug) this.updates.set(sortNewest(list));
    } catch {
      if (this.projectId() === projectId) this.failed.set(true);
    } finally {
      if (this.projectId() === projectId) this.loading.set(false);
    }
  }

  /** Posts an update; a health in it also sets the project's, so the workspace is refreshed. */
  async create(projectId: ID, input: CreateProjectUpdateInput): Promise<boolean> {
    const update = await this.run('post the update', (slug) =>
      this.api.projectUpdates.create(slug, projectId, input),
    );
    if (!update) return false;
    this.add(projectId, update);
    if (input.health) void this.trama.refetch();
    return true;
  }

  async edit(projectId: ID, updateId: ID, input: UpdateProjectUpdateInput): Promise<boolean> {
    const update = await this.run('save the update', (slug) =>
      this.api.projectUpdates.update(slug, projectId, updateId, input),
    );
    if (!update) return false;
    if (this.projectId() === projectId)
      this.updates.update((list) => list.map((u) => (u.id === updateId ? update : u)));
    if (input.health) void this.trama.refetch();
    return true;
  }

  async remove(projectId: ID, updateId: ID): Promise<boolean> {
    const slug = this.trama.slug();
    if (!slug) return false;
    try {
      await this.api.projectUpdates.remove(slug, projectId, updateId);
      if (this.projectId() === projectId) this.updates.update((list) => list.filter((u) => u.id !== updateId));
      return true;
    } catch (e) {
      const err = ApiError.from(e);
      if (!err.isForbidden) this.notifier.error('Could not delete the update', { description: err.message });
      return false;
    }
  }

  /** The tab was open: what is there now no longer counts as new. */
  markSeen(projectId: ID): void {
    const key = `${this.trama.slug() ?? ''}/${projectId}`;
    const updates = this.projectId() === projectId ? this.updates() : [];
    const next = { ...this.seen(), [key]: latestUpdateAt(updates, new Date().toISOString()) };
    this.seen.set(next);
    writeJson(SEEN_KEY, next);
  }

  private add(projectId: ID, update: ProjectUpdate): void {
    if (this.projectId() !== projectId) return;
    this.updates.update((list) => sortNewest([update, ...list.filter((u) => u.id !== update.id)]));
  }

  private async run<T>(label: string, call: (slug: string) => Promise<T>): Promise<T | undefined> {
    const slug = this.trama.slug();
    if (!slug) return undefined;
    try {
      return await call(slug);
    } catch (e) {
      const err = ApiError.from(e);
      // a 403 already shows the generic "no permission" toast
      if (!err.isForbidden) this.notifier.error(`Could not ${label}`, { description: err.message });
      return undefined;
    }
  }
}

const sortNewest = (list: readonly ProjectUpdate[]): ProjectUpdate[] =>
  [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
