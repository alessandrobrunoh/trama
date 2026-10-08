import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus, LucideScale, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  DECISION_STATUSES,
  DECISION_STATUS_META,
  NablaStore,
  UiStore,
} from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusBadge } from '../../shared/status';
import { Picker, type PickOption } from '../workstreams/picker';

@Component({
  selector: 'app-decision-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    KeyChip,
    StatusBadge,
    RelativeTimePipe,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New decision</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Decisions" [description]="description()" />

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2 sm:px-6">
      <div class="relative w-full sm:w-52">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          hlmInput
          class="h-7 w-full pl-8 text-xs"
          placeholder="Search decisions…"
          aria-label="Search decisions"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      </div>
      <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="statusFilter()" (valueChange)="statusFilter.set($event)" />
      @if (hasFilters()) {
        <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 gap-1 px-2 text-xs" (click)="clear()">
          <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
        </button>
      }
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="scale" title="No decisions yet" description="Decisions record what was chosen and why, so the next person does not have to rediscover it.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New decision</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No decisions match" description="Try another status or search.">
        <button hlmBtn size="sm" variant="outline" (click)="clear()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        @for (d of shown(); track d.id) {
          <a
            [routerLink]="['/', slug(), 'decisions', d.key]"
            [attr.data-row-id]="d.id"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 outline-none sm:px-6 md:min-h-9 md:flex-nowrap"
            [class.bg-muted]="ui.focusedRowId() === d.id"
          >
            <span class="flex min-w-0 flex-1 items-center gap-3">
              <app-key-chip [value]="d.key" class="w-16" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ d.title }}</span>
            </span>
            <span class="text-muted-foreground flex items-center gap-3 text-xs max-md:basis-full max-md:pl-[4.75rem]">
              @if (d.tags.length) {
                <span class="max-w-40 truncate">{{ d.tags.join(', ') }}</span>
              }
              <span class="max-sm:hidden">{{ d.updatedAt | relativeTime }}</span>
              <app-status-badge [status]="d.status" />
            </span>
          </a>
        }
      </div>
    }
  `,
})
export class DecisionListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly scale = LucideScale;
  protected readonly statuses: PickOption[] = DECISION_STATUSES.map((s) => ({
    value: s,
    label: DECISION_STATUS_META[s].label,
    kind: 'status',
    status: s,
  }));

  protected readonly search = signal('');
  protected readonly statusFilter = signal<string[]>([]);
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly total = computed(() => this.store.decisions().length);
  protected readonly hasFilters = computed(() => !!this.search().trim() || this.statusFilter().length > 0);

  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const statuses = new Set(this.statusFilter());
    return this.store
      .decisions()
      .filter((d) => {
        if (statuses.size && !statuses.has(d.status)) return false;
        if (!q) return true;
        return `${d.key} ${d.title} ${d.statement} ${d.tags.join(' ')}`.toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  });

  protected readonly description = computed(() => {
    const n = this.total();
    const noun = n === 1 ? 'decision' : 'decisions';
    return this.hasFilters() ? `${this.shown().length} of ${n} ${noun}` : `${n} ${noun}`;
  });

  protected create(): void {
    this.ui.openCreate('decision');
  }

  protected clear(): void {
    this.search.set('');
    this.statusFilter.set([]);
  }
}
