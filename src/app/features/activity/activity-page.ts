import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { LucideActivity, LucideBot, LucideDynamicIcon, LucideUser, LucideUsers, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { NablaStore, type DomainEvent } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { EVENT_CATEGORY_LABEL, EventLine, eventCategory, type EventCategory } from '../overview/event-line';
import { Picker, type PickOption } from '../workstreams/picker';

type TypeFilter = 'all' | Exclude<EventCategory, 'other'>;

const TYPE_TABS: TypeFilter[] = ['all', 'workstream', 'issue', 'decision', 'artifact', 'comment', 'input'];

interface DayGroup {
  key: string;
  label: string;
  events: DomainEvent[];
}

const DAY = 86_400_000;

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Workspace-wide activity (VISION §38): meaningful organisational changes, newest first, grouped
 * by day. Filters: event family, actor, team; automated (system) events can be hidden.
 * Query params `?type=issue&actor=user:usr_1&team=tm_1` preselect the filters.
 */
@Component({
  selector: 'app-activity-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmButtonImports, HlmSpinner, PageHeader, EmptyState, EventLine, Picker],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    <app-page-header title="Activity" [description]="description()">
      <div class="flex flex-wrap items-center gap-x-1 gap-y-2 border-b px-4 py-2 sm:px-6">
        <div class="-ms-1 flex flex-wrap items-center gap-0.5" role="tablist" aria-label="Event type">
          @for (t of typeTabs; track t) {
            <button
              type="button"
              role="tab"
              class="hover:bg-accent text-muted-foreground hover:text-foreground aria-selected:bg-accent aria-selected:text-foreground flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium"
              [attr.aria-selected]="type() === t"
              (click)="setType(t)"
            >
              {{ typeLabel(t) }}
              @if (counts()[t]; as n) {
                <span class="text-muted-foreground tabular-nums">{{ n }}</span>
              }
            </button>
          }
        </div>
        <span class="flex-1"></span>
        <app-picker
          variant="chip"
          label="Actor"
          [icon]="userIcon"
          [multiple]="true"
          [options]="actorOptions()"
          [value]="actors()"
          (valueChange)="actors.set($event)"
        />
        <app-picker
          variant="chip"
          label="Team"
          [icon]="teamIcon"
          [multiple]="true"
          [options]="teamOptions()"
          [value]="teams()"
          (valueChange)="teams.set($event)"
        />
        <button
          type="button"
          hlmBtn
          variant="outline"
          size="sm"
          class="h-7 gap-1.5 px-2 text-xs font-normal"
          [class.bg-accent]="!showSystem()"
          [attr.aria-pressed]="!showSystem()"
          (click)="showSystem.set(!showSystem())"
          title="Hide changes made automatically by Nabla and integrations"
        >
          <svg [lucideIcon]="botIcon" [size]="13" class="text-muted-foreground"></svg>
          {{ showSystem() ? 'Automated shown' : 'Automated hidden' }}
        </button>
        @if (filtered()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 gap-1 px-2 text-xs" (click)="clear()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
    </app-page-header>

    @if (groups().length === 0) {
      <app-empty-state
        class="m-auto"
        [icon]="activityIcon"
        [title]="filtered() ? 'No activity matches' : 'No activity yet'"
        [description]="
          filtered()
            ? 'Nothing in the loaded history matches these filters. Load older activity or clear the filters.'
            : 'Creating workstreams, triaging issues, recording decisions and linking pull requests all show up here.'
        "
      >
        <div class="flex flex-wrap justify-center gap-2">
          @if (filtered()) {
            <button hlmBtn size="sm" variant="outline" (click)="clear()">Clear filters</button>
          }
          @if (!exhausted()) {
            <button hlmBtn size="sm" variant="ghost" [disabled]="loading()" (click)="loadMore()">
              @if (loading()) {
                <hlm-spinner class="size-3.5" />
              }
              Load older activity
            </button>
          }
        </div>
      </app-empty-state>
    } @else {
      <div class="mx-auto w-full max-w-4xl px-4 pb-10 sm:px-6">
        @for (g of groups(); track g.key) {
          <section [attr.aria-label]="g.label" class="pt-5">
            <h2 class="bg-background/95 text-muted-foreground sticky top-0 z-[1] -mx-2 flex items-baseline gap-2 px-2 py-1.5 text-xs font-medium backdrop-blur">
              {{ g.label }}
              <span class="text-meta tabular-nums">{{ g.events.length }}</span>
            </h2>
            <div class="flex flex-col">
              @for (e of g.events; track e.id) {
                <app-event-line [event]="e" [slug]="slug()" class="hover:bg-hover -mx-2 rounded-md px-2" />
              }
            </div>
          </section>
        }
        <div class="flex flex-col items-center gap-1 pt-6">
          @if (exhausted()) {
            <p class="text-meta">That's the beginning of this workspace's history.</p>
          } @else {
            <button hlmBtn variant="outline" size="sm" [disabled]="loading()" (click)="loadMore()">
              @if (loading()) {
                <hlm-spinner class="size-3.5" />
              }
              Load older activity
            </button>
            <p class="text-meta">Showing activity since {{ oldestLabel() }}</p>
          }
        </div>
      </div>
    }
  `,
})
export class ActivityPage {
  readonly workspaceSlug = input<string>();
  /** Query params (component input binding). */
  readonly typeParam = input<string | undefined>(undefined, { alias: 'type' });
  readonly actorParam = input<string | undefined>(undefined, { alias: 'actor' });
  readonly teamParam = input<string | undefined>(undefined, { alias: 'team' });

  protected readonly store = inject(NablaStore);
  private readonly router = inject(Router);

  protected readonly activityIcon = LucideActivity;
  protected readonly botIcon = LucideBot;
  protected readonly userIcon = LucideUser;
  protected readonly teamIcon = LucideUsers;
  protected readonly xIcon = LucideX;
  protected readonly typeTabs = TYPE_TABS;

  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');
  protected readonly type = signal<TypeFilter>('all');
  protected readonly actors = signal<string[]>([]);
  protected readonly teams = signal<string[]>([]);
  protected readonly showSystem = signal(true);
  protected readonly loading = signal(false);
  protected readonly exhausted = signal(false);

  constructor() {
    // Seed filters from query params once they are bound.
    effect(() => {
      const t = this.typeParam();
      const a = this.actorParam();
      const tm = this.teamParam();
      untracked(() => {
        if (t && (TYPE_TABS as string[]).includes(t)) this.type.set(t as TypeFilter);
        if (a) this.actors.set(a.split(','));
        if (tm) this.teams.set(tm.split(','));
      });
    });
  }

  protected readonly actorOptions = computed<PickOption[]>(() => [
    ...this.store.users().map((u) => ({ value: `user:${u.id}`, label: u.name, kind: 'actor' as const, hint: 'person' })),
    ...this.store.agents().map((a) => ({ value: `agent:${a.id}`, label: a.name, kind: 'actor' as const, hint: 'agent' })),
  ]);
  protected readonly teamOptions = computed<PickOption[]>(() =>
    this.store.teams().map((t) => ({ value: t.id, label: t.name, kind: 'team' as const, hint: t.key })),
  );

  protected readonly filtered = computed(
    () => this.type() !== 'all' || this.actors().length > 0 || this.teams().length > 0 || !this.showSystem(),
  );

  /** Teams an event touches (owner + participating teams of its workstream, the issue's team). */
  private teamsOf(e: DomainEvent): string[] {
    const out: string[] = [];
    const ws = e.workstreamId ? this.store.workstreamById().get(e.workstreamId) : undefined;
    if (ws) out.push(ws.ownerTeamId, ...ws.participatingTeamIds);
    if (e.subject.type === 'workstream') {
      const w = this.store.workstreamById().get(e.subject.id);
      if (w) out.push(w.ownerTeamId, ...w.participatingTeamIds);
    }
    if (e.subject.type === 'issue') {
      const i = this.store.issueById().get(e.subject.id);
      if (i?.teamId) out.push(i.teamId);
    }
    if (e.subject.type === 'team') out.push(e.subject.id);
    return out;
  }

  /** Events after actor/team/system filters (before the type filter, so tab counts stay useful). */
  private readonly base = computed(() => {
    const actors = new Set(this.actors());
    const teams = new Set(this.teams());
    const system = this.showSystem();
    return this.store.events().filter((e) => {
      if (!system && e.actor.type === 'system') return false;
      if (actors.size && !actors.has(`${e.actor.type}:${e.actor.id ?? ''}`)) return false;
      if (teams.size && !this.teamsOf(e).some((t) => teams.has(t))) return false;
      return true;
    });
  });

  protected readonly counts = computed(() => {
    const c: Partial<Record<TypeFilter, number>> = { all: 0 };
    for (const e of this.base()) {
      const cat = eventCategory(e);
      c.all = (c.all ?? 0) + 1;
      if (cat !== 'other') c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  });

  private readonly shown = computed(() => {
    const t = this.type();
    return t === 'all' ? this.base() : this.base().filter((e) => eventCategory(e) === t);
  });

  protected readonly groups = computed<DayGroup[]>(() => {
    const now = new Date();
    const out: DayGroup[] = [];
    let cur: DayGroup | undefined;
    for (const e of this.shown()) {
      const key = dayKey(e.at);
      if (!cur || cur.key !== key) {
        cur = { key, label: dayLabel(e.at, now), events: [] };
        out.push(cur);
      }
      cur.events.push(e);
    }
    return out;
  });

  protected readonly description = computed(() => {
    const n = this.shown().length;
    return `${n} ${n === 1 ? 'change' : 'changes'}${this.filtered() ? ' matching' : ''} across the workspace`;
  });

  protected readonly oldestLabel = computed(() => {
    const ev = this.store.events();
    const last = ev[ev.length - 1];
    return last ? new Date(last.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  });

  protected typeLabel(t: TypeFilter): string {
    return t === 'all' ? 'All' : EVENT_CATEGORY_LABEL[t];
  }

  protected setType(t: TypeFilter): void {
    this.type.set(t);
    void this.router.navigate([], { queryParams: { type: t === 'all' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected clear(): void {
    this.type.set('all');
    this.actors.set([]);
    this.teams.set([]);
    this.showSystem.set(true);
    void this.router.navigate([], { queryParams: { type: null, actor: null, team: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected async loadMore(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      const n = await this.store.loadOlderEvents({ limit: 200 });
      if (n === 0) this.exhausted.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
