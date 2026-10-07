import { Injectable, effect, inject, signal } from '@angular/core';
import { readJson, writeJson } from '../../core/stores/storage';
import { NablaStore } from '../../core/stores/nabla.store';
import type { HitType, SearchHit } from './search.service';

export interface RecentItem {
  type: HitType;
  id: string;
  key?: string;
  title: string;
  workstreamKey?: string;
  at: number;
}

const KEY = 'nabla.recent.v1';
const MAX = 8;

/** Recently opened items from the palette / search, per workspace (localStorage). */
@Injectable({ providedIn: 'root' })
export class RecentItems {
  private readonly store = inject(NablaStore);
  private readonly all = signal<Record<string, RecentItem[]>>((readJson<Record<string, RecentItem[]>>(KEY) ?? {}) as Record<string, RecentItem[]>);

  constructor() {
    effect(() => writeJson(KEY, this.all()));
  }

  /** Recent items for the active workspace, newest first, skipping entities that no longer exist. */
  list(): RecentItem[] {
    const slug = this.store.slug();
    if (!slug) return [];
    const exists = (r: RecentItem): boolean => {
      switch (r.type) {
        case 'workstream': return this.store.workstreamById().has(r.id);
        case 'decision': return this.store.decisionById().has(r.id);
        case 'intake': return this.store.intakeById().has(r.id);
        case 'execution': return this.store.executionById().has(r.id);
        case 'repository': return this.store.repositoryById().has(r.id);
        case 'team': return this.store.teamById().has(r.id);
        default: return true;
      }
    };
    return (this.all()[slug] ?? []).filter(exists);
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
