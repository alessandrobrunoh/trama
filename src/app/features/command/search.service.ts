import { Injectable, inject } from '@angular/core';
import { ApiClient } from '../../core/api/api-client';
import { TramaStore } from '../../core/stores/trama.store';
import { fuzzyScore } from './fuzzy';

/**
 * `decision` and `record` hits come from `trama sync`: a decision an agent recorded and the record of a task's
 * thread. Both belong to a task (`key`), which is where opening them goes.
 */
export type HitType = 'project' | 'issue' | 'decision' | 'record';

/** The hits that are about a task's thread record rather than the task itself. */
export const RECORD_HIT_TYPES: readonly HitType[] = ['decision', 'record'];

/** One search result, normalised from `GET /search` or computed locally from the store. */
export interface SearchHit {
  type: HitType;
  id: string;
  key?: string;
  title: string;
  subtitle?: string;
}

export const HIT_ORDER: HitType[] = ['project', 'issue', 'decision', 'record'];
export const HIT_LABEL: Record<HitType, string> = {
  project: 'Projects',
  issue: 'Tasks',
  decision: 'Decisions',
  record: 'Thread records',
};
export const HIT_SINGULAR: Record<HitType, string> = {
  project: 'Project',
  issue: 'Task',
  decision: 'Decision',
  record: 'Thread record',
};

const TYPE_ALIASES: Record<string, HitType> = {
  projects: 'project',
  project: 'project',
  issues: 'issue',
  issue: 'issue',
  tasks: 'issue',
  decisions: 'decision',
  records: 'record',
};

function asHit(raw: unknown, forcedType?: HitType): SearchHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = (forcedType ?? r['type']) as string;
  const type = (HIT_ORDER as string[]).includes(t) ? (t as HitType) : TYPE_ALIASES[t];
  if (!type || typeof r['id'] !== 'string') return null;
  const key = typeof r['key'] === 'string' ? r['key'] : undefined;
  const title =
    typeof r['title'] === 'string' ? r['title'] : typeof r['name'] === 'string' ? r['name'] : typeof r['fullName'] === 'string' ? r['fullName'] : (key ?? '');
  return {
    type,
    id: r['id'],
    key,
    title,
    subtitle: typeof r['subtitle'] === 'string' && r['subtitle'] ? r['subtitle'] : undefined,
  };
}

/** Server search (`GET /w/:slug/search`) with a client-side fuzzy fallback over the TramaStore. */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TramaStore);

  /** Rejects on network / server errors; callers fall back to {@link local}. */
  async remote(q: string, limit = 24, types?: readonly HitType[]): Promise<SearchHit[]> {
    const slug = this.store.slug();
    if (!slug) return [];
    const res = await this.api.request<unknown>('GET', `/w/${encodeURIComponent(slug)}/search`, {
      params: { q, limit, types: types?.length ? types.join(',') : undefined },
    });
    const out: SearchHit[] = [];
    if (Array.isArray(res)) {
      for (const r of res) {
        const h = asHit(r);
        if (h) out.push(h);
      }
    } else if (res && typeof res === 'object') {
      const o = res as Record<string, unknown>;
      if (Array.isArray(o['results'])) {
        for (const r of o['results']) {
          const h = asHit(r);
          if (h) out.push(h);
        }
      } else {
        // Grouped shape `{ issues: [...], ... }`.
        for (const [k, v] of Object.entries(o)) {
          const type = TYPE_ALIASES[k] ?? ((HIT_ORDER as string[]).includes(k) ? (k as HitType) : k === 'issues' || k === 'issue' ? 'issue' : undefined);
          if (!type || !Array.isArray(v)) continue;
          for (const r of v) {
            const h = asHit(r, type);
            if (h) out.push(h);
          }
        }
      }
    }
    return out;
  }

  /** Instant fuzzy search over everything already in the snapshot. */
  local(q: string, perType = 6, only?: HitType): SearchHit[] {
    const s = this.store;
    const scored: { hit: SearchHit; score: number }[] = [];
    const push = (hit: SearchHit, text: string, extra = '') => {
      if (only && hit.type !== only) return;
      const score = Math.max(fuzzyScore(text, q), extra ? fuzzyScore(extra, q) * 0.5 : 0);
      if (score > 0) scored.push({ hit, score });
    };
    for (const p of s.projects()) push({ type: 'project', id: p.id, title: p.name }, p.name, p.summary ?? '');
    for (const i of s.issues()) push({ type: 'issue', id: i.id, key: i.key, title: i.title }, `${i.key} ${i.title}`, i.body ?? '');

    const counts = new Map<HitType, number>();
    return scored
      .sort((a, b) => b.score - a.score)
      .filter(({ hit }) => {
        const n = (counts.get(hit.type) ?? 0) + 1;
        counts.set(hit.type, n);
        return n <= perType;
      })
      .map((x) => x.hit);
  }

  /** Router commands (below `/:slug`) for a hit. */
  path(h: SearchHit): string[] {
    switch (h.type) {
      case 'issue':
      case 'decision':
      case 'record':
        // A decision or a record opens the task it belongs to.
        return ['tasks', h.key ?? h.id];
      case 'project':
        return ['projects', h.id];
    }
  }

  queryParams(_h: SearchHit): Record<string, string> | undefined {
    return undefined;
  }
}
