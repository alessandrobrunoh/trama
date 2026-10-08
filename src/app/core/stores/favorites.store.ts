// The signed-in user's favorites in the open workspace (Settings aside, the sidebar's "Favorites").
// Stored on the server per user, so they follow the person across browsers and devices.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { Favorite, FavoriteType, ID } from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { LiveSync } from '../sync/live-sync.service';
import { NablaStore } from './nabla.store';

/** A favorite resolved against the loaded workspace, ready to render. */
export interface FavoriteEntry {
  favorite: Favorite;
  type: FavoriteType;
  subjectId: ID;
  /** Main text: an issue / workstream / decision title, a team, repository or view name. */
  label: string;
  /** Key such as `BUG-142` or `AUTH-12`, when the entity has one. */
  key?: string;
  /** Router commands below `/:workspaceSlug`. */
  link: string[];
  /** Status to draw next to the label (issues and workstreams). */
  status?: string;
  /** Team color. */
  color?: string;
}

const keyOf = (type: FavoriteType, id: ID): string => `${type}:${id}`;

@Injectable({ providedIn: 'root' })
export class FavoritesStore {
  private readonly api = inject(ApiClient);
  private readonly nabla = inject(NablaStore);
  private readonly notifier = inject(Notifier);
  private readonly live = inject(LiveSync);
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** The entity the current page is about (an issue, workstream, decision, team, repository or view), if any. */
  readonly current = computed<{ type: FavoriteType; id: ID } | null>(() => {
    const [path] = this.url().split(/[?#]/);
    const [, section, ref, ...more] = path.split('/').filter(Boolean);
    if (!section || !ref || more.length) return null;
    const key = decodeURIComponent(ref);
    const n = this.nabla;
    const found = (type: FavoriteType, id: ID | undefined) => (id ? { type, id } : null);
    switch (section) {
      case 'issues': return found('issue', n.getIssue(key)?.id);
      case 'workstreams': return found('workstream', n.getWorkstream(key)?.id);
      case 'decisions': return found('decision', n.getDecision(key)?.id);
      case 'teams': return found('team', n.getTeam(key)?.id);
      case 'repositories': return found('repository', n.getRepository(key)?.id);
      case 'views': return found('view', n.getView(key)?.id);
      default: return null;
    }
  });

  readonly items = signal<readonly Favorite[]>([]);
  private readonly pinned = computed(() => new Set(this.items().map((f) => keyOf(f.type, f.subjectId))));

  /** Favorites whose entity is loaded, oldest first. Entries that cannot be resolved yet are left out. */
  readonly entries = computed<readonly FavoriteEntry[]>(() => {
    const out: FavoriteEntry[] = [];
    for (const favorite of this.items()) {
      const entry = this.resolve(favorite);
      if (entry) out.push(entry);
    }
    return out;
  });

  constructor() {
    effect(() => {
      const slug = this.nabla.slug();
      const ready = this.nabla.ready();
      untracked(() => {
        if (slug && ready) void this.load();
        else this.items.set([]);
      });
    });
    // Another tab or device of the same person pinned or unpinned something.
    this.live.events$.pipe(filter((e) => e.entity === 'favorite')).subscribe(() => void this.load());
  }

  has(type: FavoriteType, subjectId: ID | null | undefined): boolean {
    return !!subjectId && this.pinned().has(keyOf(type, subjectId));
  }

  async load(): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    try {
      const list = await this.api.favorites.list(slug);
      if (this.nabla.slug() === slug) this.items.set(list);
    } catch {
      /* favorites are a convenience; the app works without them */
    }
  }

  /** Pin or unpin, updating the sidebar immediately and rolling back if the server refuses. */
  async toggle(type: FavoriteType, subjectId: ID): Promise<void> {
    const slug = this.nabla.slug();
    if (!slug) return;
    const before = this.items();
    const existing = before.find((f) => f.type === type && f.subjectId === subjectId);
    try {
      if (existing) {
        this.items.set(before.filter((f) => f !== existing));
        await this.api.favorites.remove(slug, type, subjectId);
      } else {
        const temp: Favorite = {
          id: `fav_pending_${Date.now()}`,
          workspaceId: this.nabla.workspace()?.id ?? '',
          type,
          subjectId,
          createdAt: new Date().toISOString(),
        };
        this.items.set([...before, temp]);
        const saved = await this.api.favorites.add(slug, type, subjectId);
        this.items.update((list) => list.map((f) => (f === temp ? saved : f)));
      }
    } catch (e) {
      this.items.set(before);
      const err = ApiError.from(e);
      if (!err.isForbidden) this.notifier.error('Could not update favorites', { description: err.message });
    }
  }

  private resolve(favorite: Favorite): FavoriteEntry | null {
    const base = { favorite, type: favorite.type, subjectId: favorite.subjectId };
    switch (favorite.type) {
      case 'issue': {
        const i = this.nabla.getIssue(favorite.subjectId);
        return i ? { ...base, label: i.title, key: i.key, link: ['issues', i.key], status: i.status } : null;
      }
      case 'workstream': {
        const w = this.nabla.getWorkstream(favorite.subjectId);
        return w ? { ...base, label: w.title, key: w.key, link: ['workstreams', w.key], status: w.status } : null;
      }
      case 'decision': {
        const d = this.nabla.getDecision(favorite.subjectId);
        return d ? { ...base, label: d.title, key: d.key, link: ['decisions', d.key] } : null;
      }
      case 'team': {
        const t = this.nabla.getTeam(favorite.subjectId);
        return t ? { ...base, label: t.name, key: t.key, link: ['teams', t.key], color: t.color } : null;
      }
      case 'repository': {
        const r = this.nabla.getRepository(favorite.subjectId);
        return r ? { ...base, label: r.fullName, link: ['repositories', r.id] } : null;
      }
      case 'view': {
        const v = this.nabla.getView(favorite.subjectId);
        return v ? { ...base, label: v.name, link: ['views', v.id] } : null;
      }
    }
  }
}
