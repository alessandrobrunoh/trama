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
import { LatestIntent, mergePending, reconcileSaved, withPinned } from './latest-intent';
import { TramaStore } from './trama.store';

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
  /** Customer logo URL. */
  logoUrl?: string;
}

const keyOf = (type: FavoriteType, id: ID): string => `${type}:${id}`;

@Injectable({ providedIn: 'root' })
export class FavoritesStore {
  private readonly api = inject(ApiClient);
  private readonly trama = inject(TramaStore);
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

  /** The entity the current page is about (an issue, workstream, project, decision, team, repository, view or customer), if any. */
  readonly current = computed<{ type: FavoriteType; id: ID } | null>(() => {
    const [path] = this.url().split(/[?#]/);
    const [, section, ref, ...more] = path.split('/').filter(Boolean);
    if (!section || !ref || more.length) return null;
    const key = decodeURIComponent(ref);
    const n = this.trama;
    const found = (type: FavoriteType, id: ID | undefined) => (id ? { type, id } : null);
    switch (section) {
      case 'issues': return found('issue', n.getIssue(key)?.id);
      case 'workstreams': return found('workstream', n.getWorkstream(key)?.id);
      case 'projects': return found('project', n.getProject(key)?.id);
      case 'decisions': return found('decision', n.getDecision(key)?.id);
      case 'teams': return found('team', n.getTeam(key)?.id);
      case 'repositories': return found('repository', n.getRepository(key)?.id);
      case 'views': return found('view', n.getView(key)?.id);
      case 'customers': return found('customer', n.getCustomer(key)?.id);
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
      const slug = this.trama.slug();
      const ready = this.trama.ready();
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
    const slug = this.trama.slug();
    if (!slug) return;
    try {
      const list = await this.api.favorites.list(slug);
      if (this.trama.slug() !== slug) return;
      // Subjects mid-toggle keep what the person just chose; the list may predate it.
      this.items.update((local) => mergePending(list, local, (f) => this.intent.busy(this.syncKey(slug, f.type, f.subjectId))));
    } catch {
      /* favorites are a convenience; the app works without them */
    }
  }

  /**
   * Pin or unpin, updating the sidebar immediately. Toggles on one subject are serialised and the
   * last click wins: a click while a request is in flight only updates the wish, and the request
   * that follows brings the server to it. A failure rolls back that subject alone.
   */
  async toggle(type: FavoriteType, subjectId: ID): Promise<void> {
    const slug = this.trama.slug();
    if (!slug) return;
    const key = this.syncKey(slug, type, subjectId);
    const subject = { type, subjectId };
    const current = this.items().find((f) => f.type === type && f.subjectId === subjectId);
    // The state the server has confirmed, to roll back to; remembered when a burst of clicks starts.
    if (!this.intent.busy(key)) this.confirmed.set(key, current ?? null);
    const pin = !current;
    this.items.update((list) => withPinned(list, subject, pin, () => this.pending(type, subjectId)));
    try {
      await this.intent.push(key, pin, async (want) => {
        if (want) {
          const saved = await this.api.favorites.add(slug, type, subjectId);
          this.confirmed.set(key, saved);
          if (this.trama.slug() === slug) this.items.update((list) => reconcileSaved(list, subject, saved));
        } else {
          await this.api.favorites.remove(slug, type, subjectId);
          this.confirmed.set(key, null);
        }
      });
    } catch (e) {
      const back = this.confirmed.get(key) ?? null;
      if (this.trama.slug() === slug) {
        this.items.update((list) => {
          const without = withPinned(list, subject, false, () => this.pending(type, subjectId));
          return back ? [...without, back] : without;
        });
      }
      const err = ApiError.from(e);
      if (!err.isForbidden) this.notifier.error('Could not update favorites', { description: err.message });
    } finally {
      if (!this.intent.busy(key)) this.confirmed.delete(key);
    }
  }

  private readonly intent = new LatestIntent();
  private readonly confirmed = new Map<string, Favorite | null>();

  private syncKey(slug: string, type: FavoriteType, subjectId: ID): string {
    return `${slug}::${keyOf(type, subjectId)}`;
  }

  /** The optimistic row shown until the server answers. */
  private pending(type: FavoriteType, subjectId: ID): Favorite {
    return {
      id: `fav_pending_${Date.now()}`,
      workspaceId: this.trama.workspace()?.id ?? '',
      type,
      subjectId,
      createdAt: new Date().toISOString(),
    };
  }

  private resolve(favorite: Favorite): FavoriteEntry | null {
    const base = { favorite, type: favorite.type, subjectId: favorite.subjectId };
    switch (favorite.type) {
      case 'issue': {
        const i = this.trama.getIssue(favorite.subjectId);
        return i ? { ...base, label: i.title, key: i.key, link: ['issues', i.key], status: i.status } : null;
      }
      case 'workstream': {
        const w = this.trama.getWorkstream(favorite.subjectId);
        return w ? { ...base, label: w.title, key: w.key, link: ['workstreams', w.key], status: w.status } : null;
      }
      case 'decision': {
        const d = this.trama.getDecision(favorite.subjectId);
        return d ? { ...base, label: d.title, key: d.key, link: ['decisions', d.key] } : null;
      }
      case 'team': {
        const t = this.trama.getTeam(favorite.subjectId);
        return t ? { ...base, label: t.name, key: t.key, link: ['teams', t.key], color: t.color } : null;
      }
      case 'project': {
        const p = this.trama.getProject(favorite.subjectId);
        return p ? { ...base, label: p.name, link: ['projects', p.id], color: p.color } : null;
      }
      case 'repository': {
        const r = this.trama.getRepository(favorite.subjectId);
        return r ? { ...base, label: r.fullName, link: ['repositories', r.id] } : null;
      }
      case 'view': {
        const v = this.trama.getView(favorite.subjectId);
        return v ? { ...base, label: v.name, link: ['views', v.id] } : null;
      }
      case 'customer': {
        const c = this.trama.getCustomer(favorite.subjectId);
        return c ? { ...base, label: c.name, link: ['customers', c.id], ...(c.logoUrl ? { logoUrl: c.logoUrl } : {}) } : null;
      }
    }
  }
}
