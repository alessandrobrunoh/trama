import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideLayers, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  FIELD_DEFS,
  NablaStore,
  UiStore,
  queryItems,
  type Decision,
  type Issue,
  type SavedView,
  type ViewEntity,
  type Workstream,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { StatusBadge } from '../../shared/status';
import { IssueRow } from '../issues/issue-items';
import { buildSummary } from '../workstreams/ws-model';
import { WorkstreamRow } from '../workstreams/workstream-items';

const ENTITY_LABEL: Record<ViewEntity, string> = {
  workstream: 'Workstreams',
  issue: 'Issues',
  decision: 'Decisions',
};

@Component({
  selector: 'app-view-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    KeyChip,
    StatusBadge,
    WorkstreamRow,
    IssueRow,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (view(); as v) {
      <ng-template appTopBarActions>
        @if (canEdit()) {
          <button hlmBtn variant="outline" size="sm" class="text-destructive" (click)="remove()">
            <svg [lucideIcon]="trash" [size]="14"></svg>
            <span class="max-sm:hidden">Delete</span>
          </button>
        }
      </ng-template>

      <app-page-header [title]="v.name" [description]="description()" />

      @if (rows().length === 0) {
        <app-empty-state [icon]="layers" title="Nothing in this view" description="The saved filters do not match anything right now." />
      } @else if (v.entity === 'workstream') {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (w of workstreams(); track w.id) {
            <app-workstream-row [summary]="summary(w)" />
          }
        </div>
      } @else if (v.entity === 'issue') {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (i of issues(); track i.id) {
            <app-issue-row [issue]="i" />
          }
        </div>
      } @else {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (d of decisions(); track d.id) {
            <a
              [routerLink]="['/', slug(), 'decisions', d.key]"
              [attr.data-row-id]="d.id"
              class="hover:bg-muted/60 flex items-center gap-3 border-b px-4 py-2 sm:px-6"
            >
              <app-key-chip [value]="d.key" class="w-16" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ d.title }}</span>
              <app-status-badge [status]="d.status" />
            </a>
          }
        </div>
      }
    } @else {
      <app-empty-state [icon]="layers" title="View not found" description="It may have been deleted, or it is private to someone else.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'views']">Back to views</a>
      </app-empty-state>
    }
  `,
})
export class ViewDetailPage {
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();

  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);

  protected readonly trash = LucideTrash2;
  protected readonly layers = LucideLayers;
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly view = computed(() => this.store.getView(this.id()));
  protected readonly canEdit = computed(() => {
    const v = this.view();
    const me = this.store.me()?.id;
    if (!v || !me || !this.store.can('member')) return false;
    return v.ownerId === me || (v.shared && this.store.can('admin'));
  });

  private readonly queried = computed(() => {
    const v = this.view();
    if (!v) return [] as Array<Workstream | Issue | Decision>;
    const spec = { filters: v.filters, sort: v.sort, groupBy: v.groupBy };
    if (v.entity === 'workstream') return queryItems('workstream', this.store.workstreams(), spec);
    if (v.entity === 'issue') return queryItems('issue', this.store.issues(), spec);
    return queryItems('decision', this.store.decisions(), spec);
  });

  protected readonly rows = computed(() => this.queried());
  protected readonly workstreams = computed(() => this.rows() as Workstream[]);
  protected readonly issues = computed(() => this.rows() as Issue[]);
  protected readonly decisions = computed(() => this.rows() as Decision[]);

  protected readonly description = computed(() => {
    const v = this.view();
    if (!v) return '';
    const filters = describeFilters(v);
    const who = v.shared ? 'Shared' : 'Private';
    return `${who} · ${ENTITY_LABEL[v.entity]} · ${this.rows().length} · ${filters}`;
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Views', link: ['/', this.slug(), 'views'] },
    { label: this.view()?.name ?? 'View' },
  ]);

  protected summary(ws: Workstream) {
    return buildSummary(this.store, ws);
  }

  protected remove(): void {
    const v = this.view();
    if (!v) return;
    this.ui.setConfirmDelete({
      title: `Delete “${v.name}”?`,
      description: 'The view goes away. The work it lists does not.',
      onConfirm: async () => {
        const ok = await this.store.deleteView(v.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'views']);
      },
    });
  }
}

function describeFilters(view: SavedView): string {
  if (!view.filters.length) return 'No filters';
  const defs = FIELD_DEFS[view.entity];
  return view.filters
    .map((f) => {
      const label = defs.find((d) => d.field === f.field)?.label ?? f.field;
      const value = Array.isArray(f.value) ? f.value.join(', ') : f.value;
      return `${label} ${f.op.replaceAll('_', ' ')} ${value}`;
    })
    .join(' · ');
}
