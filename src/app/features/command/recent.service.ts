import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { readJson, writeJson } from '../../core/stores/storage';
import { TramaStore } from '../../core/stores/trama.store';
import type { HitType, SearchHit } from './search.service';
import { visitedRef } from './visited-ref';

export interface RecentItem {
  type: HitType;
  id: string;
  key?: string;
  title: string;
  workstreamKey?: string;
  at: number;
}

const KEY = 'trama.recent.v1';
const MAX = 12;

@Injectable({ providedIn: 'root' })
export class RecentItems {
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly all = signal<Record<string, RecentItem[]>>((readJson<Record<string, RecentItem[]>>(KEY) ?? {}) as Record<string, RecentItem[]>);

  /** The detail page that is open and not yet recorded (waits until the workspace data has loaded). */
  private readonly visiting = signal<ReturnType<typeof visitedRef>>(null);
  /** The record the open detail page shows, so the palette can leave it out of "recently viewed". */
  readonly current = signal<{ type: HitType; id: string } | null>(null);

  constructor() {
    effect(() => writeJson(KEY, this.all()));
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) {
        this.visiting.set(visitedRef(e.urlAfterRedirects));
        if (!this.visiting()) this.current.set(null);
      }
    });
    // Every opened detail page counts, however it was reached (link, list, URL, palette).
    effect(() => {
      const v = this.visiting();
      if (!v || v.slug !== this.store.slug()) return;
      const hit = this.resolve(v.type, v.ref);
      if (!hit) return;
      untracked(() => {
        this.current.set({ type: hit.type, id: hit.id });
        this.push(hit);
        this.visiting.set(null);
      });
    });
  }

  private resolve(type: HitType, ref: string): SearchHit | null {
    switch (type) {
      case 'issue': {
        const i = this.store.getIssue(ref);
        return i ? { type, id: i.id, key: i.key, title: i.title } : null;
      }
      case 'workstream': {
        const w = this.store.getWorkstream(ref);
        return w ? { type, id: w.id, key: w.key, title: w.title } : null;
      }
      case 'decision': {
        const d = this.store.getDecision(ref);
        return d ? { type, id: d.id, key: d.key, title: d.title } : null;
      }
      case 'project': {
        const p = this.store.getProject(ref);
        return p ? { type, id: p.id, title: p.name } : null;
      }
      case 'repository': {
        const r = this.store.getRepository(ref);
        return r ? { type, id: r.id, title: r.fullName } : null;
      }
      case 'team': {
        const t = this.store.getTeam(ref);
        return t ? { type, id: t.id, key: t.key, title: t.name } : null;
      }
      default:
        return null;
    }
  }

  /** Recent items for the active workspace, newest first, skipping entities that no longer exist. */
  list(): RecentItem[] {
    const slug = this.store.slug();
    if (!slug) return [];
    const exists = (r: RecentItem): boolean => {
      switch (r.type) {
        case 'workstream': return this.store.workstreamById().has(r.id);
        case 'decision': return this.store.decisionById().has(r.id);
        case 'issue': return this.store.issueById().has(r.id);
        case 'repository': return this.store.repositoryById().has(r.id);
        case 'team': return this.store.teamById().has(r.id);
        default: return true;
      }
    };
    return (this.all()[slug] ?? [])
      .map((r) => ((r.type as string) === 'intake' ? { ...r, type: 'issue' as const } : r))
      .filter(exists);
  }

  push(h: SearchHit): void {
    const slug = this.store.slug();
    if (!slug) return;
    const item: RecentItem = { type: h.type, id: h.id, key: h.key, title: h.title, workstreamKey: h.workstreamKey, at: Date.now() };
    this.all.update((m) => ({
      ...m,
      [slug]: [item, ...(m[slug] ?? []).filter((r) => !(r.type === item.type && r.id === item.id))].slice(0, MAX),
    }));
  }
}
