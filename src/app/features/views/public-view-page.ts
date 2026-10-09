import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { LucideDynamicIcon, LucideEye, LucideLink2Off } from '@lucide/angular';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiClient } from '../../core/api/api-client';
import type { PublicView, ViewEntity } from '../../core/contracts/domain';
import { shortDate } from '../../core/format';
import {
  DECISION_STATUS_META,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_HEALTH_META,
  PROJECT_STATUS_META,
  WORKSTREAM_STATUS_META,
} from '../../core/meta';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon, type AnyStatus } from '../../shared/status';
import { ENTITY_ICON, ENTITY_LABEL, STATUS_ENTITY } from './view-model';

type Labels = Record<string, { label: string }>;

/**
 * `/shared/:token`: a saved view shared by link ("anyone with the link"). Public and read-only on
 * purpose: it renders the fixed result the server returns for the token and nothing else. There is
 * no filter, sort, grouping or layout control, no workspace navigation and no links into the app,
 * and the component never touches the workspace store or the session.
 */
@Component({
  selector: 'app-public-view-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmSpinner, EmptyState, KeyChip, PriorityIcon, StatusIcon],
  host: { class: 'bg-background text-foreground flex min-h-dvh flex-col' },
  template: `
    @if (state() === 'loading') {
      <div class="flex flex-1 items-center justify-center py-24"><hlm-spinner /></div>
    } @else if (view(); as v) {
      <header class="border-b px-4 py-4 sm:px-6">
        <div class="mx-auto flex max-w-5xl flex-col gap-1">
          <p class="text-meta flex items-center gap-1.5">
            <svg [lucideIcon]="eyeIcon" [size]="12"></svg>
            Read-only view shared from {{ v.workspaceName }}
          </p>
          <h1 class="flex items-center gap-2 text-lg font-semibold">
            <svg [lucideIcon]="entityIcon()" [size]="16" class="text-muted-foreground shrink-0"></svg>
            <span class="min-w-0 truncate">{{ v.name }}</span>
          </h1>
          <p class="text-meta">
            {{ v.total }} {{ entityLabel().toLowerCase() }}@if (v.truncated) { (showing the first {{ shown() }}) }
            · as of {{ asOf() }}
          </p>
        </div>
      </header>

      <main class="mx-auto w-full max-w-5xl flex-1 px-0 pb-12">
        @if (v.total === 0) {
          <app-empty-state [icon]="entityIcon()" title="Nothing in this view" description="No {{ entityLabel().toLowerCase() }} match right now." />
        } @else if (v.layout === 'board' && v.groupBy) {
          <div class="flex gap-3 overflow-x-auto px-4 py-3 sm:px-6">
            @for (g of v.groups; track g.key) {
              <section class="flex w-72 shrink-0 flex-col gap-2" [attr.aria-label]="label(g.key, g.label)">
                <header class="flex h-8 items-center gap-2 px-1 text-xs font-medium">
                  {{ label(g.key, g.label) }}
                  <span class="text-muted-foreground tabular-nums">{{ g.items.length }}</span>
                </header>
                @for (item of g.items; track item.id) {
                  <div class="bg-card flex flex-col gap-1.5 rounded-lg border p-2.5">
                    <span class="flex items-center gap-1.5">
                      @if (item.status) {
                        <app-status-icon [status]="asStatus(item.status)" [entity]="statusEntity()" />
                      }
                      @if (item.key) {
                        <app-key-chip [value]="item.key" />
                      }
                    </span>
                    <span class="line-clamp-3 text-sm leading-snug font-medium">{{ item.title }}</span>
                    <span class="text-meta flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      @if (item.priority && item.priority !== 'none') {
                        <app-priority-icon [priority]="item.priority" />
                      }
                      @if (item.assignee) {
                        <span>{{ item.assignee }}</span>
                      }
                      @if (item.targetDate) {
                        <span>Due {{ date(item.targetDate) }}</span>
                      }
                    </span>
                  </div>
                }
              </section>
            }
          </div>
        } @else {
          @for (g of v.groups; track g.key) {
            @if (v.groupBy) {
              <div class="bg-muted/40 flex h-8 items-center gap-2 border-b px-4 sm:px-6">
                <span class="text-xs font-medium">{{ label(g.key, g.label) }}</span>
                <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
              </div>
            }
            @for (item of g.items; track item.id) {
              <div class="flex min-h-9 items-center gap-3 border-b px-4 py-1.5 sm:px-6">
                @if (item.status) {
                  <app-status-icon [status]="asStatus(item.status)" [entity]="statusEntity()" />
                }
                @if (item.key) {
                  <app-key-chip [value]="item.key" class="w-16" />
                }
                <span class="min-w-0 flex-1 truncate text-sm">{{ item.title }}</span>
                @for (l of (item.labels ?? []).slice(0, 2); track l) {
                  <span class="border-border-strong text-muted-foreground hidden h-5 items-center rounded-full border px-1.5 text-[11px] md:inline-flex">{{ l }}</span>
                }
                @if (item.team) {
                  <span class="text-meta hidden max-w-32 truncate md:inline">{{ item.team }}</span>
                }
                @if (item.assignee) {
                  <span class="text-meta hidden max-w-32 truncate sm:inline">{{ item.assignee }}</span>
                }
                @if (item.priority && item.priority !== 'none') {
                  <app-priority-icon [priority]="item.priority" />
                }
                @if (item.targetDate) {
                  <span class="text-meta tabular-nums max-sm:hidden">{{ date(item.targetDate) }}</span>
                }
              </div>
            }
          }
        }
      </main>
    } @else {
      <div class="flex flex-1 items-center justify-center">
        <app-empty-state
          [icon]="offIcon"
          title="This link is not available"
          description="The view may have been unshared, the link replaced, or the address mistyped. Ask the owner for a new link."
        />
      </div>
    }
  `,
})
export class PublicViewPage implements OnInit {
  /** `shared/:token` (route params are bound to inputs). */
  readonly token = input<string>();

  private readonly api = inject(ApiClient);
  private readonly meta = inject(Meta);

  protected readonly eyeIcon = LucideEye;
  protected readonly offIcon = LucideLink2Off;

  protected readonly state = signal<'loading' | 'ready' | 'missing'>('loading');
  protected readonly view = signal<PublicView | null>(null);

  protected readonly entity = computed<ViewEntity>(() => this.view()?.entity ?? 'workstream');
  protected readonly entityIcon = computed(() => ENTITY_ICON[this.entity()]);
  protected readonly entityLabel = computed(() => ENTITY_LABEL[this.entity()]);
  protected readonly statusEntity = computed(() => STATUS_ENTITY[this.entity()]);
  protected readonly shown = computed(() => this.view()?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0);
  protected readonly asOf = computed(() => shortDate(this.view()?.generatedAt));

  ngOnInit(): void {
    this.meta.updateTag({ name: 'robots', content: 'noindex, nofollow' });
    this.meta.updateTag({ name: 'referrer', content: 'no-referrer' });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.view.set(await this.api.publicViews.get(this.token() ?? ''));
      this.state.set('ready');
    } catch {
      this.state.set('missing');
    }
  }

  protected asStatus(value: string): AnyStatus {
    return value as AnyStatus;
  }

  protected date(iso: string): string {
    return shortDate(iso);
  }

  /** Group heading: names are resolved by the server; enum values get their display label. */
  protected label(key: string, resolved: string): string {
    const v = this.view();
    if (!v) return resolved;
    if (!key) return 'None';
    const field = v.groupBy;
    const table = this.enumTable(v.entity, field);
    return table?.[key]?.label ?? resolved;
  }

  private enumTable(entity: ViewEntity, field: string | undefined): Labels | null {
    if (field === 'priority') return PRIORITY_META;
    if (field === 'kind') return ISSUE_KIND_META;
    if (field === 'health') return PROJECT_HEALTH_META;
    if (field !== 'status') return null;
    if (entity === 'workstream') return WORKSTREAM_STATUS_META;
    if (entity === 'issue') return ISSUE_STATUS_META;
    if (entity === 'project') return PROJECT_STATUS_META;
    return DECISION_STATUS_META;
  }
}
