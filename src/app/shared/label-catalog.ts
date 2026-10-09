// The label catalog as the UI uses it: lookup by id, usage counts, "recent" for pickers, and inline creation.
import { Injectable, computed, inject, signal } from '@angular/core';
import { LABEL_ASSIGN_MAX, LABEL_SWATCHES, NablaStore, type WorkspaceLabel } from '../core';
import { readJson, writeJson } from '../core/stores/storage';

/** How many records carry one label, per kind of record. */
export interface LabelUsage {
  issues: number;
  workstreams: number;
  projects: number;
  repositories: number;
  total: number;
}

export const NO_USAGE: LabelUsage = { issues: 0, workstreams: 0, projects: 0, repositories: 0, total: 0 };

const RECENT_MAX = 4;
/** Labels offered as suggestions when nothing is typed. */
const SUGGESTED_MAX = 4;
/** Below this many labels a "suggested" group only repeats the list. */
const SUGGEST_FROM = 8;
const recentKey = (slug: string | null) => `trama.labels.recent.${slug ?? ''}`;

/** "12 issues · 3 workstreams"; "Not used" when nothing carries the label. */
export function describeUsage(u: LabelUsage, empty = 'Not used'): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(u.issues, 'issue', 'issues');
  add(u.workstreams, 'workstream', 'workstreams');
  add(u.projects, 'project', 'projects');
  add(u.repositories, 'repository', 'repositories');
  return parts.length ? parts.join(' · ') : empty;
}

@Injectable({ providedIn: 'root' })
export class LabelCatalog {
  private readonly store = inject(NablaStore);

  readonly all = computed<readonly WorkspaceLabel[]>(() => this.store.settings().labels);
  readonly active = computed(() => this.all().filter((label) => !label.archived));
  readonly byId = computed(() => new Map(this.all().map((label) => [label.id, label])));
  readonly maxPerRecord = LABEL_ASSIGN_MAX;

  /** Members may create labels while tagging; the rest of the catalog is for admins. */
  readonly canCreate = computed(() => this.store.can('member'));
  readonly canManage = computed(() => this.store.can('admin'));

  /** Per label id, how many issues, workstreams, projects and repositories carry it. */
  readonly usage = computed(() => {
    const map = new Map<string, LabelUsage>();
    const bump = (ids: readonly string[] | undefined, key: 'issues' | 'workstreams' | 'projects' | 'repositories') => {
      for (const id of ids ?? []) {
        const u = map.get(id) ?? { ...NO_USAGE };
        u[key] += 1;
        u.total += 1;
        map.set(id, u);
      }
    };
    for (const i of this.store.issues()) bump(i.labels, 'issues');
    for (const w of this.store.workstreams()) bump(w.labels, 'workstreams');
    for (const p of this.store.projects()) bump(p.labels, 'projects');
    for (const r of this.store.repositories()) bump(r.labels, 'repositories');
    return map;
  });

  /** Saved views that filter on each label (a delete or merge rewrites them). */
  readonly viewsByLabel = computed(() => {
    const map = new Map<string, string[]>();
    for (const view of this.store.views()) {
      for (const filter of view.filters) {
        if (filter.field !== 'labels') continue;
        for (const id of Array.isArray(filter.value) ? filter.value : [filter.value]) map.set(id, [...(map.get(id) ?? []), view.name]);
      }
    }
    return map;
  });

  private readonly picked = signal<{ slug: string | null; ids: string[] } | null>(null);
  /** Labels this person picked last, newest first. A per-browser convenience, never shared. */
  readonly recent = computed(() => {
    const slug = this.store.slug();
    const picked = this.picked();
    const stored = picked && picked.slug === slug ? picked.ids : (readJson<{ ids: string[] }>(recentKey(slug))?.ids ?? []);
    return stored.filter((id) => this.byId().has(id) && !this.byId().get(id)?.archived).slice(0, RECENT_MAX);
  });

  get(id: string): WorkspaceLabel | undefined {
    return this.byId().get(id);
  }

  usageOf(id: string): LabelUsage {
    return this.usage().get(id) ?? NO_USAGE;
  }

  /**
   * The labels to offer, in the one order every label list uses (picker and the `L` command list):
   * `suggested` (recent picks, then the most used, only in a long list) and `rest` (alphabetical).
   * Archived labels appear only when `keep` holds them, so they can be unticked.
   */
  arrange(keep: ReadonlySet<string> = new Set(), withSuggested = true): { suggested: WorkspaceLabel[]; rest: WorkspaceLabel[] } {
    const offered = this.all()
      .filter((label) => !label.archived || keep.has(label.id))
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const suggested: WorkspaceLabel[] = [];
    if (withSuggested && offered.length >= SUGGEST_FROM) {
      const byId = new Map(offered.map((label) => [label.id, label]));
      const add = (label?: WorkspaceLabel) => {
        if (label && !label.archived && !suggested.includes(label) && suggested.length < SUGGESTED_MAX) suggested.push(label);
      };
      for (const id of this.recent()) add(byId.get(id));
      const byUse = [...offered].sort((a, b) => this.usageOf(b.id).total - this.usageOf(a.id).total);
      for (const label of byUse) if (this.usageOf(label.id).total > 0) add(label);
    }
    const skip = new Set(suggested.map((label) => label.id));
    return { suggested, rest: offered.filter((label) => !skip.has(label.id)) };
  }

  /** The first swatch no label uses yet: what a new label gets unless the person picks one. */
  nextColor(): string {
    const used = new Set(this.all().map((label) => label.color));
    return LABEL_SWATCHES.find((color) => !used.has(color)) ?? LABEL_SWATCHES[this.all().length % LABEL_SWATCHES.length];
  }

  /** Remember a pick so the picker offers it first next time. */
  touch(id: string): void {
    const slug = this.store.slug();
    const next = [id, ...this.recent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    this.picked.set({ slug, ids: next });
    writeJson(recentKey(slug), { ids: next });
  }

  /** Whether a name is taken (case-insensitive), by any label including archived ones. */
  find(name: string): WorkspaceLabel | undefined {
    const wanted = name.trim().toLowerCase();
    return wanted ? this.all().find((label) => label.name.toLowerCase() === wanted) : undefined;
  }

  /** Create a custom label. Resolves the new label, or `undefined` when the API refused (a toast says why). */
  create(name: string, color?: string): Promise<WorkspaceLabel | undefined> {
    return this.store.createLabel(color ? { name: name.trim(), color } : { name: name.trim() });
  }
}
