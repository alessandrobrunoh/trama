// The public `/shared/:token` page (v3 "39 · Shared view · List" and "40 · Shared view · Board"): a thin
// bar, the view's title with its counts, the grouping the owner chose, a search that stays inside the
// view, then the rows (or the board columns). Read-only; the owner's filters are fixed by the server.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import {
  LucideArrowUpRight,
  LucideColumns3,
  LucideDynamicIcon,
  LucideEye,
  LucideLink2,
  LucideLink2Off,
  LucideList,
  LucideLock,
  LucideSearch,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { format, isToday, parseISO } from 'date-fns';
import { ApiClient } from '../../core/api/api-client';
import type {
  PublicView as PublicViewDto,
  PublicViewGroup,
  PublicViewItem,
  ViewEntity,
} from '../../core/contracts/domain';
import { shortDate } from '../../core/format';
import {
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_STATUS_META,
} from '../../core/meta';
import { Clipboard } from '../../core/notify/notifier';
import { EmptyState } from '../../shared/empty-state';
import { StatusIcon, type AnyStatus } from '../../shared/status';
import { TramaLogo } from '../../shared/trama-logo';
import { V3Priority } from '../../shared/v3';
import { V3FilterChip, V3LabelChip, V3NameAvatar } from './view-atoms';
import { ENTITY_LABEL, STATUS_ENTITY, fieldLabel } from './view-model';

type Labels = Record<string, { label: string }>;

/** Rows a list group (or the compact Done column) shows before "Show N more". */
const LIST_LIMIT = 12;
const DONE_LIMIT = 5;

/**
 * Renders a public view by link, either standalone at `/shared/:token` or embedded on a public page.
 * It shows only the fixed projection returned by the server: no workspace navigation or view controls,
 * and it never touches the workspace store or session.
 */
@Component({
  selector: 'app-public-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmSpinner,
    EmptyState,
    StatusIcon,
    TramaLogo,
    V3Priority,
    V3FilterChip,
    V3LabelChip,
    V3NameAvatar,
  ],
  host: {
    class: 'bg-background text-foreground',
    '[class.block]': 'embedded()',
    '[class.flex]': '!embedded()',
    '[class.min-h-dvh]': '!embedded()',
    '[class.flex-col]': '!embedded()',
    '(document:keydown)': 'onKey($event)',
  },
  template: `
    @if (state() === 'loading') {
      <div class="flex items-center justify-center py-12" [class.flex-1]="!embedded()">
        <hlm-spinner />
      </div>
    } @else if (view(); as v) {
      @if (!embedded()) {
        <header
          class="bg-card border-border flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4 md:px-6"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <app-trama-logo [size]="20" />
            <span class="font-title text-foreground text-[17px] leading-none">Trama</span>
            <span class="text-faint font-mono text-xs max-sm:hidden">/</span>
            <span class="text-faint truncate font-mono text-xs max-sm:hidden">{{
              v.workspaceName
            }}</span>
            <span class="text-faint font-mono text-xs max-sm:hidden">/</span>
            <span class="text-foreground truncate font-mono text-xs max-sm:hidden">{{
              v.name
            }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2.5">
            <span
              class="bg-secondary text-muted-foreground inline-flex items-center gap-1.5 px-2 py-[3px] font-mono text-[11px] leading-[14px]"
            >
              <svg [lucideIcon]="eyeIcon" [size]="12" aria-hidden="true"></svg>
              Read-only
            </span>
            <button hlmBtn variant="outline" type="button" (click)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="13" aria-hidden="true"></svg>
              <span class="max-sm:hidden">Copy link</span>
              <span class="sm:hidden">Link</span>
            </button>
            <a hlmBtn routerLink="/register" class="max-sm:hidden">
              Try Trama free
              <svg [lucideIcon]="arrowIcon" [size]="12" aria-hidden="true"></svg>
            </a>
          </div>
        </header>

        <section class="flex w-full flex-col gap-5 pt-8 pb-7 md:pt-12" [class]="gutter">
          <div class="flex items-center gap-2">
            <v3-name-avatar [name]="v.workspaceName" [size]="18" />
            <span class="text-faint font-mono text-[11.5px] leading-[14px]"
              >Shared from {{ v.workspaceName }} · anyone with the link can view</span
            >
          </div>

          <div class="flex items-end justify-between gap-8">
            <div class="flex min-w-0 flex-col gap-2.5">
              <div class="flex items-center gap-3.5">
                <span
                  class="border-border text-primary flex size-9 shrink-0 items-center justify-center border"
                  aria-hidden="true"
                >
                  <svg [lucideIcon]="isBoard() ? boardIcon : listIcon" [size]="16"></svg>
                </span>
                <h1
                  class="font-title text-foreground min-w-0 text-[30px] leading-[normal] tracking-[-0.5px] md:text-[44px] md:tracking-[-0.8px]"
                >
                  {{ v.name }}
                </h1>
              </div>
              <p class="text-muted-foreground text-[15px] leading-[normal]">
                {{ v.total }} {{ entityLabel().toLowerCase() }}
                @if (v.truncated) {
                  (showing the first {{ shown() }})
                }
                · as of {{ asOf() }}
              </p>
            </div>
            <dl class="flex shrink-0 items-end gap-8 max-md:hidden">
              <div class="flex flex-col items-end gap-1">
                <dt class="text-faint font-mono text-[10px] leading-[normal] tracking-[1px]">
                  {{ entityLabel().toUpperCase() }}
                </dt>
                <dd class="text-foreground font-mono text-[15px] leading-[normal]">{{ v.total }}</dd>
              </div>
              <div class="flex flex-col items-end gap-1">
                <dt class="text-faint font-mono text-[10px] leading-[normal] tracking-[1px]">
                  UPDATED
                </dt>
                <dd class="text-foreground font-mono text-[15px] leading-[normal]">
                  {{ updated() }}
                </dd>
              </div>
            </dl>
          </div>

          <div class="border-border flex flex-wrap items-center gap-2 border-t pt-4">
            @if (groupField(); as g) {
              <v3-filter-chip [field]="isBoard() ? 'Columns' : 'Group'" op="by" [value]="g" />
            }
            <span class="flex-1 max-md:hidden"></span>
            <span
              class="text-faint inline-flex items-center gap-1.5 font-mono text-[11px] leading-[14px] max-md:hidden"
            >
              <svg [lucideIcon]="lockIcon" [size]="12" aria-hidden="true"></svg>
              Filters set by the owner
            </span>
            <label
              class="bg-card border-border focus-within:border-primary flex w-full items-center gap-2 border px-2.5 py-[5px] md:w-[220px]"
            >
              <svg
                [lucideIcon]="searchIcon"
                [size]="13"
                class="text-faint shrink-0 md:hidden"
                aria-hidden="true"
              ></svg>
              <input
                #search
                type="search"
                class="placeholder:text-faint text-foreground min-w-0 flex-1 bg-transparent font-mono text-[11.5px] leading-[14px] outline-none"
                placeholder="Search in this view"
                aria-label="Search in this view"
                autocomplete="off"
                [value]="query()"
                (input)="query.set(search.value)"
                (keydown.escape)="clearSearch(search)"
              />
              <kbd
                class="bg-secondary text-muted-foreground px-[5px] font-mono text-[10.5px] leading-[16px] max-md:hidden"
                >/</kbd
              >
            </label>
          </div>
        </section>
      }

      <main
        class="flex w-full flex-col gap-8"
        [class]="embedded() ? 'pb-4' : 'flex-1 pt-2 pb-10'"
        [class.mx-auto]="!embedded()"
        [class.max-w-[1440px]]="!embedded()"
        [class.px-4]="!embedded()"
        [class.md:px-10]="!embedded()"
        [class.xl:px-[120px]]="!embedded()"
      >
        @if (v.total === 0) {
          <app-empty-state
            [icon]="entityIcon()"
            title="Nothing in this view"
            description="No {{ entityLabel().toLowerCase() }} match right now."
          />
        } @else if (visible().length === 0) {
          <app-empty-state
            [icon]="searchIcon"
            title="No matches"
            description="Nothing in this view matches “{{ query().trim() }}”."
          />
        } @else if (isBoard()) {
          <div class="flex items-start gap-4 overflow-x-auto pb-2">
            @for (g of visible(); track g.key) {
              @if (isDone(g)) {
                <section class="flex w-[260px] shrink-0 flex-col gap-2" [attr.aria-label]="name(g)">
                  <header class="flex items-center gap-2 px-0.5 pb-1.5">
                    @if (v.groupBy === 'status') {
                      <app-status-icon
                        [status]="asStatus(g.key)"
                        [entity]="statusEntity()"
                        [size]="14"
                      />
                    }
                    <span class="text-foreground text-[13.5px] leading-[17px] font-medium">{{
                      name(g)
                    }}</span>
                    <span class="text-faint font-mono text-[11px] leading-[14px]">{{
                      g.items.length
                    }}</span>
                  </header>
                  <div class="border-border flex flex-col border">
                    @for (item of limited(g, doneLimit); track item.id) {
                      <div
                        class="border-border flex flex-col gap-1 border-b px-3 py-2.5 last:border-b-0"
                      >
                        <div
                          class="text-faint flex items-start justify-between gap-2 font-mono text-[10.5px] leading-[13px]"
                        >
                          <span>{{ item.key }}</span>
                          @if (item.targetDate) {
                            <span>{{ date(item.targetDate) }}</span>
                          }
                        </div>
                        <span class="text-muted-foreground text-[12.5px] leading-[16px]">{{
                          item.title
                        }}</span>
                      </div>
                    }
                  </div>
                  @if (hiddenCount(g, doneLimit) > 0 || isExpanded(g)) {
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-foreground w-fit px-0.5 py-1 text-left font-mono text-[11.5px]"
                      (click)="toggle(g)"
                    >
                      {{
                        isExpanded(g) ? 'Show fewer' : 'Show ' + hiddenCount(g, doneLimit) + ' more'
                      }}
                    </button>
                  }
                </section>
              } @else {
                <section
                  class="flex min-w-[240px] flex-1 flex-col gap-2"
                  [attr.aria-label]="name(g)"
                >
                  <header class="flex items-center gap-2 px-0.5 pb-1.5">
                    @if (v.groupBy === 'status') {
                      <app-status-icon
                        [status]="asStatus(g.key)"
                        [entity]="statusEntity()"
                        [size]="14"
                      />
                    }
                    <span class="text-foreground text-[13.5px] leading-[17px] font-medium">{{
                      name(g)
                    }}</span>
                    <span class="text-faint font-mono text-[11px] leading-[14px]">{{
                      g.items.length
                    }}</span>
                  </header>
                  @for (item of g.items; track item.id) {
                    <article class="bg-card border-border flex flex-col gap-2.5 border p-3">
                      <div class="flex items-center gap-2">
                        <span class="text-faint font-mono text-[11px] leading-[14px]">{{
                          item.key
                        }}</span>
                        <span class="flex-1"></span>
                        @if (item.assignee) {
                          <v3-name-avatar [name]="item.assignee" [size]="18" />
                        }
                      </div>
                      <span class="text-foreground text-[13.5px] leading-[19px]">{{
                        item.title
                      }}</span>
                      @if (hasMeta(item)) {
                        <div class="flex flex-wrap items-center gap-2">
                          @if (item.priority && item.priority !== 'none') {
                            <v3-priority [priority]="item.priority" [label]="false" />
                          }
                          @for (l of (item.labels ?? []).slice(0, 2); track l) {
                            <v3-label-chip [label]="l" [compact]="true" />
                          }
                          @if (item.targetDate) {
                            <span class="text-faint font-mono text-[10.5px] leading-[14px]"
                              >Due {{ date(item.targetDate) }}</span
                            >
                          }
                        </div>
                      }
                    </article>
                  }
                </section>
              }
            }
          </div>
        } @else {
          @for (g of visible(); track g.key) {
            <section class="flex w-full flex-col" [attr.aria-label]="name(g)">
              @if (v.groupBy) {
                <div class="border-border flex items-center gap-2.5 border-b pb-2.5">
                  <h2 class="font-title text-foreground text-[20px] leading-[20px]">
                    {{ name(g) }}
                  </h2>
                  <span class="text-faint font-mono text-[11px] leading-[14px]">{{
                    g.items.length
                  }}</span>
                </div>
              }
              @for (item of limited(g, listLimit); track item.id) {
                <div
                  class="border-border flex min-h-[42px] items-center gap-3.5 border-b px-2 py-1.5"
                >
                  @if (item.status) {
                    <app-status-icon
                      [status]="asStatus(item.status)"
                      [entity]="statusEntity()"
                      [size]="14"
                    />
                  }
                  @if (item.key) {
                    <span
                      class="text-faint w-[72px] shrink-0 font-mono text-[11.5px] leading-[14px] max-sm:hidden"
                      >{{ item.key }}</span
                    >
                  }
                  <span class="text-foreground min-w-0 flex-1 truncate text-sm leading-[18px]">{{
                    item.title
                  }}</span>
                  @for (l of (item.labels ?? []).slice(0, 2); track l) {
                    <v3-label-chip [label]="l" class="max-md:hidden" />
                  }
                  @if (item.priority && item.priority !== 'none') {
                    <v3-priority [priority]="item.priority" [label]="false" />
                  }
                  @if (item.assignee) {
                    <v3-name-avatar [name]="item.assignee" [size]="20" class="max-sm:hidden" />
                  }
                  @if (item.targetDate) {
                    <span
                      class="text-faint w-12 shrink-0 text-right font-mono text-[11px] leading-[14px] max-sm:hidden"
                      >{{ date(item.targetDate) }}</span
                    >
                  }
                </div>
              }
              @if (hiddenCount(g, listLimit) > 0 || isExpanded(g)) {
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-2 py-3 text-left font-mono text-[11.5px]"
                  (click)="toggle(g)"
                >
                  {{
                    isExpanded(g)
                      ? 'Show fewer'
                      : 'Show ' + hiddenCount(g, listLimit) + ' more' + (v.groupBy ? ' from ' + name(g) : '')
                  }}
                </button>
              }
            </section>
          }
        }
      </main>

      @if (!embedded()) {
        <footer
          class="border-border flex shrink-0 items-center justify-between gap-4 border-t py-5"
          [class]="gutter"
        >
          <span
            class="text-faint inline-flex items-center gap-2 font-mono text-[11px] leading-[14px]"
          >
            <app-trama-logo [size]="16" />
            Shared with Trama · plan in Trama, work in Delta
          </span>
          <a
            routerLink="/register"
            class="text-muted-foreground hover:text-foreground font-mono text-[11px] leading-[14px]"
            >Create your own shared view →</a
          >
        </footer>
      }
    } @else {
      <div class="flex items-center justify-center py-12" [class.flex-1]="!embedded()">
        <app-empty-state
          [icon]="offIcon"
          [title]="embedded() ? 'This view is not available' : 'This link is not available'"
          [description]="
            embedded()
              ? 'The Shared View is not configured or is no longer available.'
              : 'The view may have been unshared, the link replaced, or the address mistyped. Ask the owner for a new link.'
          "
        />
      </div>
    }
  `,
})
export class PublicView implements OnInit {
  /** `shared/:token` (route params are passed by the page wrapper) or a configured site view. */
  readonly token = input<string>();
  /** Embed one of the configured public marketing views without the standalone page chrome. */
  readonly viewSource = input<'roadmap' | 'changelog'>();
  readonly embedded = input(false);

  private readonly api = inject(ApiClient);
  private readonly clipboard = inject(Clipboard);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly eyeIcon = LucideEye;
  protected readonly linkIcon = LucideLink2;
  protected readonly arrowIcon = LucideArrowUpRight;
  protected readonly lockIcon = LucideLock;
  protected readonly searchIcon = LucideSearch;
  protected readonly listIcon = LucideList;
  protected readonly boardIcon = LucideColumns3;
  protected readonly offIcon = LucideLink2Off;
  protected readonly listLimit = LIST_LIMIT;
  protected readonly doneLimit = DONE_LIMIT;

  /** Page gutter of the standalone page: 120px at 1440, narrower below. */
  protected readonly gutter = 'mx-auto w-full max-w-[1440px] px-4 md:px-10 xl:px-[120px]';

  protected readonly state = signal<'loading' | 'ready' | 'missing'>('loading');
  protected readonly view = signal<PublicViewDto | null>(null);
  /** Text typed in "Search in this view" (client side, over the rows the server returned). */
  protected readonly query = signal('');
  /** Group keys whose hidden rows are shown. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly entity = computed<ViewEntity>(() => this.view()?.entity ?? 'issue');
  protected readonly entityIcon = computed(() => (this.isBoard() ? this.boardIcon : this.listIcon));
  protected readonly entityLabel = computed(() => ENTITY_LABEL[this.entity()]);
  protected readonly statusEntity = computed(() => STATUS_ENTITY[this.entity()]);
  protected readonly isBoard = computed(() => {
    const v = this.view();
    return !!v && v.layout === 'board' && !!v.groupBy;
  });
  protected readonly shown = computed(
    () => this.view()?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0,
  );
  protected readonly asOf = computed(() => shortDate(this.view()?.generatedAt));
  /** "today 14:02" / "Nov 24 14:02". */
  protected readonly updated = computed(() => {
    const iso = this.view()?.generatedAt;
    if (!iso) return '';
    const d = parseISO(iso);
    return isToday(d) ? `today ${format(d, 'HH:mm')}` : format(d, 'MMM d HH:mm');
  });
  protected readonly groupField = computed(() => {
    const v = this.view();
    return v?.groupBy ? fieldLabel(v.entity, v.groupBy) : null;
  });

  /** The groups after the in-view search; empty groups drop out while searching. */
  protected readonly visible = computed<PublicViewGroup[]>(() => {
    const v = this.view();
    if (!v) return [];
    const q = this.query().trim().toLowerCase();
    if (!q) return v.groups;
    return v.groups
      .map((g) => ({ ...g, items: g.items.filter((item) => this.matches(item, q)) }))
      .filter((g) => g.items.length > 0);
  });

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const token = this.token() ?? (await this.configuredToken());
      if (!token) {
        this.state.set('missing');
        return;
      }
      this.view.set(await this.api.publicViews.get(token));
      this.state.set('ready');
    } catch {
      this.state.set('missing');
    }
  }

  private async configuredToken(): Promise<string | null> {
    const source = this.viewSource();
    if (!source) return null;
    const config = await this.api.publicConfig();
    return source === 'roadmap' ? config.roadmapViewToken : config.changelogViewToken;
  }

  private matches(item: PublicViewItem, q: string): boolean {
    return [item.key, item.title, item.assignee, item.project, ...(item.labels ?? [])]
      .filter((s): s is string => !!s)
      .some((s) => s.toLowerCase().includes(q));
  }

  protected copyLink(): void {
    void this.clipboard.copy(location.href, 'Link copied');
  }

  /** `/` jumps to the search field, like in the app. */
  protected onKey(e: KeyboardEvent): void {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    const box = this.searchBox();
    if (!box) return;
    e.preventDefault();
    box.nativeElement.focus();
  }

  protected clearSearch(box: HTMLInputElement): void {
    this.query.set('');
    box.value = '';
    box.blur();
  }

  protected asStatus(value: string): AnyStatus {
    return value as AnyStatus;
  }

  protected date(iso: string): string {
    return shortDate(iso);
  }

  protected hasMeta(item: PublicViewItem): boolean {
    return (
      (!!item.priority && item.priority !== 'none') || !!item.labels?.length || !!item.targetDate
    );
  }

  /** The compact column of finished work (board grouped by status). */
  protected isDone(g: PublicViewGroup): boolean {
    const v = this.view();
    return v?.entity === 'issue' && v.groupBy === 'status' && g.key === 'done';
  }

  protected isExpanded(g: PublicViewGroup): boolean {
    return this.expanded().has(g.key);
  }

  protected toggle(g: PublicViewGroup): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (!next.delete(g.key)) next.add(g.key);
      return next;
    });
  }

  /** Rows shown now: all of them while searching, when embedded, or after "Show more". */
  protected limited(g: PublicViewGroup, limit: number): PublicViewItem[] {
    if (this.embedded() || this.query().trim() || this.isExpanded(g)) return g.items;
    return g.items.slice(0, limit);
  }

  protected hiddenCount(g: PublicViewGroup, limit: number): number {
    return this.limited(g, limit) === g.items ? 0 : g.items.length - limit;
  }

  /** Group heading: names are resolved by the server; enum values get their display label. */
  protected name(g: PublicViewGroup): string {
    const v = this.view();
    if (!v) return g.label;
    if (!g.key) return 'None';
    const table = this.enumTable(v.entity, v.groupBy);
    return table?.[g.key]?.label ?? g.label;
  }

  private enumTable(entity: ViewEntity, field: string | undefined): Labels | null {
    if (field === 'priority') return PRIORITY_META;
    if (field === 'kind') return ISSUE_KIND_META;
    if (field !== 'status') return null;
    if (entity === 'issue') return ISSUE_STATUS_META;
    return PROJECT_STATUS_META;
  }
}

@Component({
  selector: 'app-public-view-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PublicView],
  host: { class: 'block' },
  template: `<app-public-view [token]="token()" />`,
})
export class PublicViewPage implements OnInit {
  /** `shared/:token` (route params are bound to inputs). */
  readonly token = input<string>();

  private readonly meta = inject(Meta);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    this.meta.updateTag({ name: 'robots', content: 'noindex, nofollow' });
    this.meta.updateTag({ name: 'referrer', content: 'no-referrer' });
    // These tags are only for this page: do not leave `noindex` on whatever the SPA shows next.
    this.destroyRef.onDestroy(() => {
      this.meta.removeTag("name='robots'");
      this.meta.removeTag("name='referrer'");
    });
  }
}
