import { Injectable, inject } from '@angular/core';
import { ApiClient } from '../../core/api/api-client';
import { TramaStore } from '../../core/stores/trama.store';
import { fuzzyScore } from './fuzzy';

export type HitType = 'workstream' | 'project' | 'issue' | 'customer' | 'decision' | 'artifact' | 'repository' | 'team';

/** One search result, normalised from `GET /search` or computed locally from the store. */
export interface SearchHit {
  type: HitType;
  id: string;
  key?: string;
  title: string;
  subtitle?: string;
  /** For executions and artifacts: the workstream they belong to. */
  workstreamKey?: string;
}

export const HIT_ORDER: HitType[] = ['workstream', 'project', 'decision', 'issue', 'customer', 'artifact', 'repository', 'team'];
export const HIT_LABEL: Record<HitType, string> = {
  workstream: 'Workstreams',
  project: 'Projects',
  decision: 'Decisions',
  issue: 'Issues',
  customer: 'Customers',
  artifact: 'Artifacts',
  repository: 'Repositories',
  team: 'Teams',
};
export const HIT_SINGULAR: Record<HitType, string> = {
  workstream: 'Workstream',
  project: 'Project',
  decision: 'Decision',
  issue: 'Issue',
  customer: 'Customer',
  artifact: 'Artifact',
  repository: 'Repository',
  team: 'Team',
};

const TYPE_ALIASES: Record<string, HitType> = {
  workstreams: 'workstream',
  projects: 'project',
  project: 'project',
  decisions: 'decision',
  issues: 'issue',
  artifacts: 'artifact',
  repositories: 'repository',
  repository: 'repository',
  teams: 'team',
  customer: 'customer',
  customers: 'customer',
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
    workstreamKey: typeof r['workstreamKey'] === 'string' ? r['workstreamKey'] : undefined,
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
        // Grouped shape `{ workstreams: [...], issues: [...], ... }`.
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
    const wsKey = (id: string | undefined) => (id ? s.workstreamById().get(id)?.key : undefined);
    const scored: { hit: SearchHit; score: number }[] = [];
    const push = (hit: SearchHit, text: string, extra = '') => {
      if (only && hit.type !== only) return;
      const score = Math.max(fuzzyScore(text, q), extra ? fuzzyScore(extra, q) * 0.5 : 0);
      if (score > 0) scored.push({ hit, score });
    };
    for (const w of s.workstreams()) push({ type: 'workstream', id: w.id, key: w.key, title: w.title }, `${w.key} ${w.title}`, w.objective);
    for (const p of s.projects()) push({ type: 'project', id: p.id, title: p.name }, p.name, p.summary ?? '');
    for (const d of s.decisions()) push({ type: 'decision', id: d.id, key: d.key, title: d.title }, `${d.key} ${d.title}`, d.statement);
    for (const i of s.issues()) push({ type: 'issue', id: i.id, key: i.key, title: i.title }, `${i.key} ${i.title}`, i.body ?? '');
    for (const c of s.customers()) push({ type: 'customer', id: c.id, title: c.name, subtitle: c.domains.join(', ') }, `${c.name} ${c.domains.join(' ')}`);
    for (const a of s.artifacts())
      push({ type: 'artifact', id: a.id, title: a.title, subtitle: a.externalId, workstreamKey: wsKey(a.workstreamId) }, a.title, a.externalId ?? '');
    for (const r of s.repositories()) push({ type: 'repository', id: r.id, title: r.fullName }, r.fullName);
    for (const t of s.teams()) push({ type: 'team', id: t.id, key: t.key, title: t.name }, `${t.key} ${t.name}`);

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
      case 'workstream':
        return ['workstreams', h.key ?? h.id];
      case 'decision':
        return ['decisions', h.key ?? h.id];
      case 'issue':
        return ['issues', h.key ?? h.id];
      case 'customer':
        return ['customers', h.id];
      case 'project':
        return ['projects', h.id];
      case 'repository':
        return ['repositories', h.id];
      case 'team':
        return ['teams', h.key ?? h.id];
      case 'artifact': {
        const a = this.store.artifactById().get(h.id);
        const key = h.workstreamKey ?? this.store.getWorkstream(a?.workstreamId)?.key;
        if (key) return ['workstreams', key];
        const issue = this.store.getIssue(a?.issueId);
        if (issue) return ['issues', issue.key];
        return a?.projectId ? ['projects', a.projectId] : ['workstreams'];
      }
    }
  }

  queryParams(h: SearchHit): Record<string, string> | undefined {
    if (h.type !== 'artifact') return undefined;
    const a = this.store.artifactById().get(h.id);
    return a?.workstreamId || h.workstreamKey ? { tab: 'artifacts' } : undefined;
  }
}
