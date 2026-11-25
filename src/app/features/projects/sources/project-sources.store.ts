// The sources (routing rules) of the project being looked at. Loaded on demand, one project at a time:
// the project page needs the count for its tab, the Sources tab the rules and the week's numbers.
import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import type { CreateRoutingRuleInput, UpdateRoutingRuleInput } from '../../../core/api/api.types';
import type {
  GitProvider,
  ID,
  RoutingConnectionOption,
  RoutingRule,
  RoutingRulesOverview,
  RoutingSuggestions,
} from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';

export type SourceResult = { ok: true; rule: RoutingRule } | { ok: false; message: string };

@Injectable({ providedIn: 'root' })
export class ProjectSourcesStore {
  private readonly api = inject(ApiClient);
  private readonly trama = inject(TramaStore);
  private readonly notifier = inject(Notifier);

  /** The project the overview belongs to. */
  readonly projectId = signal<ID | null>(null);
  readonly overview = signal<RoutingRulesOverview | null>(null);
  readonly loading = signal(false);
  readonly failed = signal(false);

  readonly rules = computed(() => this.overview()?.rules ?? []);
  readonly count = computed(() => this.rules().length);
  readonly stats = computed(() => this.overview()?.stats ?? { tasksArrived: 0, unmatchedPlaced: 0, rulesFailing: 0 });
  readonly canManage = computed(() => this.overview()?.canManage ?? false);

  /** Loads (or reloads) the sources of a project. Another project's rules are dropped first. */
  async load(projectId: ID): Promise<void> {
    const slug = this.trama.slug();
    if (!slug) return;
    if (this.projectId() !== projectId) {
      this.projectId.set(projectId);
      this.overview.set(null);
    }
    this.loading.set(true);
    this.failed.set(false);
    try {
      const overview = await this.api.routing.overview(slug, projectId, { quiet: true });
      if (this.projectId() === projectId && this.trama.slug() === slug) this.overview.set(overview);
    } catch {
      if (this.projectId() === projectId) this.failed.set(true);
    } finally {
      if (this.projectId() === projectId) this.loading.set(false);
    }
  }

  /** The connections this person may add a source through. Empty when they cannot be read. */
  async connections(projectId: ID, provider: GitProvider): Promise<RoutingConnectionOption[]> {
    const slug = this.trama.slug();
    if (!slug) return [];
    try {
      return await this.api.routing.connections(slug, projectId, provider, { quiet: true });
    } catch {
      return [];
    }
  }

  async suggestions(projectId: ID, provider: GitProvider, connectionId: ID | undefined, q: string): Promise<RoutingSuggestions> {
    const slug = this.trama.slug();
    if (!slug) return { items: [] };
    try {
      return await this.api.routing.suggestions(slug, projectId, { provider, connectionId, q: q || undefined }, { quiet: true });
    } catch (e) {
      return { items: [], error: ApiError.from(e).message };
    }
  }

  async create(projectId: ID, input: CreateRoutingRuleInput): Promise<SourceResult> {
    return this.run('add the source', projectId, (slug) => this.api.routing.create(slug, projectId, input));
  }

  async update(projectId: ID, ruleId: ID, input: UpdateRoutingRuleInput): Promise<SourceResult> {
    return this.run('update the source', projectId, (slug) => this.api.routing.update(slug, projectId, ruleId, input));
  }

  async remove(projectId: ID, ruleId: ID): Promise<boolean> {
    const slug = this.trama.slug();
    if (!slug) return false;
    try {
      await this.api.routing.remove(slug, projectId, ruleId);
      await this.load(projectId);
      return true;
    } catch (e) {
      const err = ApiError.from(e);
      if (!err.isForbidden) this.notifier.error('Could not remove the source', { description: err.message });
      return false;
    }
  }

  private async run(
    label: string,
    projectId: ID,
    call: (slug: string) => Promise<RoutingRule>,
  ): Promise<SourceResult> {
    const slug = this.trama.slug();
    if (!slug) return { ok: false, message: 'No workspace is open.' };
    try {
      const rule = await call(slug);
      await this.load(projectId);
      return { ok: true, rule };
    } catch (e) {
      const err = ApiError.from(e);
      // a 403 already shows the generic "no permission" toast; the message stays for the form
      if (err.isForbidden) return { ok: false, message: `You can't ${label} in this project.` };
      return { ok: false, message: err.message };
    }
  }
}
