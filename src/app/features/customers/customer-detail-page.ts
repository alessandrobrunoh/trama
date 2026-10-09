import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideBell,
  LucideBellRing,
  LucideCircleCheck,
  LucideDynamicIcon,
  LucideExternalLink,
  LucidePencil,
  LucidePlus,
  LucideStar,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  CUSTOMER_STATUSES,
  CustomerSubscriptionsStore,
  ISSUE_STATUS_META,
  ListStateStore,
  NablaStore,
  UiStore,
  normalizeCustomerDomains,
  normalizeHttpUrl,
  type CustomerRequest,
  type CustomerStatus,
  type Priority,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Markdown } from '../../shared/markdown';
import { PageHeader } from '../../shared/page-header';
import { PriorityIcon } from '../../shared/priority-icon';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { PROJECT_STATUS_META } from '../projects/project-model';
import { CustomerAvatar } from './customer-avatar';
import {
  compactNumber,
  customerActivity,
  customerStats,
  groupWork,
  requestRows,
  requestState,
  sortWork,
  splitDomains,
  workRows,
  type RequestState,
  type WorkGroup,
} from './customer-model';

type Tab = 'requests' | 'work' | 'activity' | 'details';
type RequestFilter = 'all' | 'open' | 'delivered' | 'important';

const TABS: readonly Tab[] = ['requests', 'work', 'activity', 'details'];
const STATE_LABEL: Record<RequestState, string> = { open: 'Waiting', delivered: 'Delivered', dropped: 'Dropped' };
const STATE_TONE: Record<RequestState, string> = {
  open: 'border-border text-muted-foreground',
  delivered: 'border-tone-green/40 text-tone-green',
  dropped: 'border-border text-muted-foreground line-through',
};
const WORK_GROUPS: { value: WorkGroup; label: string }[] = [
  { value: 'state', label: 'Waiting / delivered' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'team', label: 'Team' },
  { value: 'kind', label: 'Issues / projects' },
];
const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };

@Component({
  selector: 'app-customer-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmInputImports,
    HlmTooltip,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    StatusIcon,
    PriorityIcon,
    TopBarActions,
    CustomerAvatar,
    Markdown,
    ActorAvatar,
    RelativeTimePipe,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (customer(); as c) {
      <ng-template appTopBarActions>
        <button
          hlmBtn
          size="sm"
          variant="outline"
          class="gap-1.5"
          [attr.aria-pressed]="following()"
          [hlmTooltip]="following() ? 'You are told about new, important and delivered requests. Click to stop.' : 'Get told when a request is added, flagged important or delivered'"
          (click)="subs.toggle(c.id)"
        >
          <svg [lucideIcon]="following() ? bellRing : bell" [size]="14"></svg>
          <span class="max-sm:hidden">{{ following() ? 'Following' : 'Follow' }}</span>
        </button>
        @if (canManage()) {
          <button hlmBtn size="sm" variant="outline" (click)="addRequest()"><svg [lucideIcon]="plus" [size]="14"></svg><span class="max-sm:hidden">Add request</span></button>
          <button hlmBtn size="sm" variant="outline" class="max-sm:hidden" (click)="archive()">{{ c.archivedAt ? 'Restore' : 'Archive' }}</button>
        }
        @if (canDelete()) {
          <button hlmBtn size="sm" variant="outline" class="max-sm:hidden" (click)="remove()"><svg [lucideIcon]="trash" [size]="14"></svg>Delete</button>
        }
      </ng-template>

      <app-page-header [title]="c.name" [description]="c.domains.join(' · ')" />

      <!-- Who they are, and what they are waiting on -->
      <section class="flex flex-wrap items-start gap-x-8 gap-y-4 border-b px-4 py-4 sm:px-6" aria-label="Customer summary">
        <div class="flex min-w-0 items-center gap-3">
          <app-customer-avatar [customer]="c" [size]="44" />
          <div class="min-w-0">
            <h2 class="truncate text-base font-semibold">{{ c.name }}</h2>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span class="rounded border px-1.5 capitalize" [class.text-tone-green]="c.status === 'active'" [class.text-muted-foreground]="c.status !== 'active'">{{ c.status }}</span>
              @if (stats()?.tier; as t) {
                <span class="rounded border px-1.5" [style.color]="t.color" [style.border-color]="t.color">{{ t.name }}</span>
              }
              @if (c.archivedAt) { <span class="text-muted-foreground rounded border px-1.5">Archived</span> }
              @for (d of c.domains; track d) {
                <span class="text-muted-foreground font-mono">{{ d }}</span>
              }
            </div>
          </div>
        </div>
        <dl class="flex flex-wrap gap-x-7 gap-y-3">
          @for (s of tiles(); track s.label) {
            <div>
              <dt class="text-muted-foreground text-xs">{{ s.label }}</dt>
              <dd class="mt-0.5 text-lg font-semibold tabular-nums" [class.text-tone-amber]="s.accent">{{ s.value }}</dd>
            </div>
          }
        </dl>
      </section>

      <nav class="scrollbar-none flex items-center gap-0.5 overflow-x-auto border-b px-4 py-1.5 sm:px-6" aria-label="Customer sections">
        @for (t of tabList(); track t.id) {
          <a
            [routerLink]="[]"
            [queryParams]="{ tab: t.id === 'requests' ? null : t.id }"
            queryParamsHandling="merge"
            class="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors"
            [class]="currentTab() === t.id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-hover hover:text-foreground'"
            [attr.aria-current]="currentTab() === t.id ? 'page' : null"
          >
            {{ t.label }}
            @if (t.count !== null) { <span class="text-muted-foreground text-xs tabular-nums">{{ t.count }}</span> }
          </a>
        }
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto">
        @switch (currentTab()) {
          @case ('requests') {
            @if (rows().length === 0) {
              <app-empty-state
                title="No requests yet"
                description="Add a request when this customer asked for something. It sits on an issue or a project, and the issue stays the unit of work."
              >
                @if (canManage()) {
                  <button hlmBtn size="sm" (click)="addRequest()"><svg [lucideIcon]="plus" [size]="14"></svg>Add request</button>
                }
              </app-empty-state>
            } @else {
              <div class="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 sm:px-6" role="group" aria-label="Filter requests">
                @for (f of requestFilters(); track f.id) {
                  <button
                    type="button"
                    class="h-7 rounded-md border px-2.5 text-xs transition-colors"
                    [class]="requestFilter() === f.id ? 'border-border-strong bg-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
                    [attr.aria-pressed]="requestFilter() === f.id"
                    (click)="requestFilter.set(f.id)"
                  >{{ f.label }} <span class="tabular-nums opacity-70">{{ f.count }}</span></button>
                }
              </div>
              @for (r of visibleRows(); track r.request.id) {
                <article class="border-b px-4 py-3 sm:px-6" [class.bg-tone-amber/5]="r.request.important && r.state === 'open'">
                  <div class="flex items-center gap-2">
                    @if (r.issue; as issue) {
                      <a [routerLink]="['/', slug(), 'issues', issue.key]" class="hover:bg-muted/60 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1">
                        <app-status-icon [status]="issue.status" entity="issue" />
                        <span class="text-muted-foreground w-20 shrink-0 font-mono text-xs">{{ issue.key }}</span>
                        <span class="min-w-0 flex-1 truncate text-sm">{{ issue.title }}</span>
                      </a>
                    } @else if (r.project; as project) {
                      <a [routerLink]="['/', slug(), 'projects', project.id]" class="hover:bg-muted/60 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1">
                        <span class="size-2.5 shrink-0 rounded-full" [class]="projectStatus[project.status].dot"></span>
                        <span class="text-muted-foreground w-20 shrink-0 text-xs">Project</span>
                        <span class="min-w-0 flex-1 truncate text-sm">{{ project.name }}</span>
                      </a>
                    }
                    <span class="shrink-0 rounded border px-1.5 text-[11px]" [class]="stateTone[r.state]">{{ stateLabel[r.state] }}</span>
                    <button
                      type="button"
                      class="hover:bg-accent inline-flex h-7 w-7 items-center justify-center rounded"
                      [class.text-tone-amber]="r.request.important"
                      [class.text-muted-foreground]="!r.request.important"
                      [attr.aria-pressed]="r.request.important"
                      [attr.aria-label]="r.request.important ? 'Not important' : 'Mark important'"
                      [hlmTooltip]="r.request.important ? 'Important for this customer. Click to unmark.' : 'Mark important'"
                      [disabled]="!canManage()"
                      (click)="toggleImportant(r.request)"
                    >
                      <svg [lucideIcon]="star" [size]="14" [attr.fill]="r.request.important ? 'currentColor' : 'none'"></svg>
                    </button>
                    @if (canManage()) {
                      <button type="button" class="text-muted-foreground hover:bg-accent inline-flex h-7 w-7 items-center justify-center rounded" aria-label="Edit request" (click)="startEdit(r.request)">
                        <svg [lucideIcon]="pencil" [size]="13"></svg>
                      </button>
                      <button type="button" class="text-muted-foreground hover:text-destructive hover:bg-accent inline-flex h-7 w-7 items-center justify-center rounded" aria-label="Delete request" (click)="deleteRequest(r.request)">
                        <svg [lucideIcon]="trash" [size]="13"></svg>
                      </button>
                    }
                  </div>
                  @if (editingId() === r.request.id) {
                    <div class="mt-2 flex flex-col gap-2 pl-1">
                      <textarea
                        class="border-border bg-background min-h-24 w-full resize-y rounded-md border px-2.5 py-2 text-sm leading-relaxed outline-none"
                        aria-label="Request"
                        placeholder="What did the customer ask for? Markdown works."
                        maxlength="20000"
                        [value]="draftBody()"
                        (input)="draftBody.set($any($event.target).value)"
                        (keydown.meta.enter)="saveEdit(r.request)"
                        (keydown.control.enter)="saveEdit(r.request)"
                      ></textarea>
                      <input hlmInput class="h-8 text-[13px]" type="url" aria-label="Source URL" placeholder="Source link (ticket, email thread…)" maxlength="2000" [value]="draftSource()" (input)="draftSource.set($any($event.target).value)" />
                      @if (requestError()) { <p class="text-destructive text-xs">{{ requestError() }}</p> }
                      <div class="flex gap-2">
                        <button hlmBtn size="sm" type="button" (click)="saveEdit(r.request)">Save</button>
                        <button hlmBtn size="sm" variant="ghost" type="button" (click)="cancelEdit()">Cancel</button>
                      </div>
                    </div>
                  } @else if (r.request.body) {
                    <app-markdown class="mt-1 pl-1" [source]="r.request.body" />
                  }
                  <div class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 pl-1 text-xs">
                    <span class="inline-flex items-center gap-1">
                      <app-actor-avatar [actor]="r.request.createdBy" [size]="14" />
                      {{ store.actorName(r.request.createdBy) }} · {{ r.request.createdAt | relativeTime }}
                    </span>
                    @if (safeSource(r.request); as href) {
                      <a [href]="href" target="_blank" rel="noopener noreferrer nofollow" class="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2">
                        <svg [lucideIcon]="external" [size]="12"></svg> Source
                      </a>
                    }
                  </div>
                </article>
              } @empty {
                <p class="text-muted-foreground px-4 py-6 text-sm sm:px-6">No requests match this filter.</p>
              }
            }
          }

          @case ('work') {
            @if (work().length === 0) {
              <app-empty-state title="No work yet" description="The issues and projects this customer asked for show up here, grouped by what is still waiting." />
            } @else {
              <div class="flex items-center gap-2 border-b px-4 py-2 text-xs sm:px-6">
                <label class="text-muted-foreground flex items-center gap-1.5">
                  Group by
                  <select class="border-input bg-background text-foreground h-7 rounded-md border px-1.5 text-xs" aria-label="Group work" [value]="workGroup()" (change)="workGroup.set($any($event.target).value)">
                    @for (g of workGroups; track g.value) { <option [value]="g.value">{{ g.label }}</option> }
                  </select>
                </label>
                <span class="text-muted-foreground ml-auto tabular-nums">{{ work().length }} {{ work().length === 1 ? 'item' : 'items' }}</span>
              </div>
              @for (g of workBuckets(); track g.key) {
                <div class="bg-muted/40 flex items-center gap-2 border-b px-4 py-1.5 text-xs sm:px-6">
                  <span class="font-medium">{{ workLabel(g.key) }}</span>
                  <span class="text-muted-foreground tabular-nums">{{ g.rows.length }}</span>
                </div>
                @for (w of g.rows; track w.id) {
                  <a
                    [routerLink]="w.kind === 'issue' ? ['/', slug(), 'issues', w.key] : ['/', slug(), 'projects', w.id]"
                    class="hover:bg-muted/60 flex min-h-10 items-center gap-3 border-b px-4 py-2 sm:px-6"
                  >
                    <app-priority-icon [priority]="w.priority" class="shrink-0" />
                    @if (w.kind === 'issue') {
                      <span class="text-muted-foreground w-20 shrink-0 font-mono text-xs">{{ w.key }}</span>
                      <app-status-icon [status]="$any(w.status)" entity="issue" />
                    } @else {
                      <span class="text-muted-foreground w-20 shrink-0 text-xs">Project</span>
                      <span class="size-2.5 shrink-0 rounded-full" [class]="projectDot(w.status)"></span>
                    }
                    <span class="min-w-0 flex-1 truncate text-sm" [class.text-muted-foreground]="w.state !== 'open'">{{ w.title }}</span>
                    @if (w.important) {
                      <svg [lucideIcon]="star" [size]="12" class="text-tone-amber shrink-0" fill="currentColor"></svg>
                    }
                    <span class="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">{{ w.requests }} {{ w.requests === 1 ? 'ask' : 'asks' }}</span>
                    <span class="shrink-0 rounded border px-1.5 text-[11px]" [class]="stateTone[w.state]">{{ stateLabel[w.state] }}</span>
                  </a>
                }
              }
            }
          }

          @case ('activity') {
            @if (activity().length === 0) {
              <app-empty-state title="Nothing yet" description="Changes to this customer and its requests show up here, with deliveries as the work gets done." />
            } @else {
              <ol class="px-4 py-3 sm:px-6">
                @for (a of activity(); track a.id) {
                  <li class="flex items-start gap-3 border-b py-2.5 last:border-b-0">
                    @if (a.actor) {
                      <app-actor-avatar [actor]="a.actor" [size]="18" class="mt-0.5" />
                    } @else {
                      <svg [lucideIcon]="done" [size]="18" class="text-tone-green mt-0.5 shrink-0"></svg>
                    }
                    <p class="min-w-0 flex-1 text-sm">
                      @if (a.actor) { <span class="font-medium">{{ store.actorName(a.actor) }}</span>{{ ' ' }} }
                      @if (a.link; as link) {
                        <a [routerLink]="['/', slug(), ...link]" class="hover:underline">{{ a.actor ? lower(a.text) : a.text }}</a>
                      } @else {
                        {{ a.actor ? lower(a.text) : a.text }}
                      }
                    </p>
                    <span class="text-muted-foreground shrink-0 text-xs">{{ a.at | relativeTime }}</span>
                  </li>
                }
              </ol>
            }
          }

          @case ('details') {
            @if (canManage()) {
              <form class="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2 sm:px-6 lg:max-w-4xl lg:grid-cols-4" (submit)="save($event)">
                <label class="flex flex-col gap-1 text-xs lg:col-span-1">
                  Name
                  <input hlmInput name="name" required maxlength="200" class="h-9" [value]="c.name" />
                </label>
                <label class="flex flex-col gap-1 text-xs sm:col-span-1 lg:col-span-3">
                  Domains (comma separated, the first is the primary)
                  <input hlmInput name="domains" required maxlength="2000" class="h-9" [value]="c.domains.join(', ')" />
                </label>
                <label class="flex flex-col gap-1 text-xs sm:col-span-2 lg:col-span-4">
                  Logo URL
                  <input hlmInput name="logoUrl" type="url" maxlength="2000" class="h-9" placeholder="https://…/logo.png" [value]="c.logoUrl ?? ''" />
                </label>
                <label class="flex flex-col gap-1 text-xs">
                  Annual revenue
                  <input hlmInput name="revenue" type="number" min="0" step="1" class="h-9" [value]="c.revenue ?? ''" />
                </label>
                <label class="flex flex-col gap-1 text-xs">
                  Size (people)
                  <input hlmInput name="size" type="number" min="0" step="1" class="h-9" [value]="c.size ?? ''" />
                </label>
                <label class="flex flex-col gap-1 text-xs">
                  Status
                  <select name="status" class="border-border bg-background h-9 rounded-md border px-2 text-sm capitalize">
                    @for (s of statuses; track s) {
                      <option [value]="s" [selected]="c.status === s">{{ s }}</option>
                    }
                  </select>
                </label>
                <label class="flex flex-col gap-1 text-xs">
                  Tier
                  <select name="tierId" class="border-border bg-background h-9 rounded-md border px-2 text-sm">
                    <option value="" [selected]="!c.tierId">No tier</option>
                    @for (t of tiers(); track t.id) {
                      <option [value]="t.id" [selected]="c.tierId === t.id">{{ t.name }}</option>
                    }
                  </select>
                </label>
                <div class="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
                  <button hlmBtn size="sm" type="submit">Save</button>
                  <button hlmBtn size="sm" variant="outline" type="button" class="sm:hidden" (click)="archive()">{{ c.archivedAt ? 'Restore' : 'Archive' }}</button>
                  @if (canDelete()) { <button hlmBtn size="sm" variant="outline" type="button" class="sm:hidden" (click)="remove()">Delete</button> }
                  @if (formError()) { <p class="text-destructive text-xs">{{ formError() }}</p> }
                </div>
              </form>
            } @else {
              <dl class="text-muted-foreground flex flex-wrap gap-x-8 gap-y-2 px-4 py-4 text-sm sm:px-6">
                <div><dt class="text-xs">Domains</dt><dd class="text-foreground font-mono">{{ c.domains.join(', ') }}</dd></div>
                @if (c.revenue !== undefined) { <div><dt class="text-xs">Revenue</dt><dd class="text-foreground tabular-nums">{{ c.revenue }}</dd></div> }
                @if (c.size !== undefined) { <div><dt class="text-xs">Size</dt><dd class="text-foreground tabular-nums">{{ c.size }}</dd></div> }
              </dl>
            }
          }
        }
      </div>
    } @else if (store.ready()) {
      <app-empty-state title="Customer not found" description="It may have been deleted, or the link is from another workspace.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'customers']">Back to customers</a>
      </app-empty-state>
    }
  `,
})
export class CustomerDetailPage {
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();
  /** Query `?tab=work|activity|details`; the requests are the default. */
  readonly tab = input<string>();

  protected readonly store = inject(NablaStore);
  protected readonly subs = inject(CustomerSubscriptionsStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly listState = inject(ListStateStore);

  protected readonly bell = LucideBell;
  protected readonly bellRing = LucideBellRing;
  protected readonly plus = LucidePlus;
  protected readonly trash = LucideTrash2;
  protected readonly star = LucideStar;
  protected readonly pencil = LucidePencil;
  protected readonly external = LucideExternalLink;
  protected readonly done = LucideCircleCheck;
  protected readonly statuses = CUSTOMER_STATUSES;
  protected readonly stateLabel = STATE_LABEL;
  protected readonly stateTone = STATE_TONE;
  protected readonly workGroups = WORK_GROUPS;
  protected readonly projectStatus = PROJECT_STATUS_META;

  protected readonly formError = signal('');
  protected readonly requestError = signal('');
  protected readonly editingId = signal<string | null>(null);
  protected readonly draftBody = signal('');
  protected readonly draftSource = signal('');
  // How the lists are cut survives navigation inside the app (see ListStateStore).
  protected readonly requestFilter = this.listState.remember<RequestFilter>('customer.requests', 'all');
  protected readonly workGroup = this.listState.remember<WorkGroup>('customer.workGroup', 'state');

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly customer = computed(() => this.store.getCustomer(this.id()));
  protected readonly tiers = computed(() => this.store.settings().customerTiers);
  protected readonly canManage = computed(() => this.store.allowed('manageCustomers'));
  protected readonly canDelete = computed(() => this.store.allowed('deleteCustomers'));
  protected readonly following = computed(() => this.subs.isFollowing(this.customer()?.id));
  protected readonly currentTab = computed<Tab>(() => (TABS as readonly string[]).includes(this.tab() ?? '') ? (this.tab() as Tab) : 'requests');

  protected readonly stats = computed(() => {
    const c = this.customer();
    if (!c) return undefined;
    return customerStats([c], this.store.customerRequests(), this.store.issueById(), this.store.projectById(), this.tiers())[0];
  });
  protected readonly tiles = computed(() => {
    const c = this.customer();
    const s = this.stats();
    if (!c || !s) return [];
    return [
      { label: 'Requests', value: String(s.requests), accent: false },
      { label: 'Waiting', value: String(s.open), accent: false },
      { label: 'Important, waiting', value: String(s.openImportant), accent: s.openImportant > 0 },
      { label: 'Delivered', value: String(s.delivered), accent: false },
      ...(c.revenue !== undefined ? [{ label: 'Revenue', value: compactNumber(c.revenue), accent: false }] : []),
      ...(c.size !== undefined ? [{ label: 'Size', value: compactNumber(c.size), accent: false }] : []),
    ];
  });

  /** This customer's requests with their issue or project and where each one stands. */
  protected readonly rows = computed(() => {
    const c = this.customer();
    if (!c) return [];
    const issues = this.store.issueById();
    const projects = this.store.projectById();
    return requestRows(c.id, this.store.customerRequests(), issues, projects).map((row) => ({
      ...row,
      state: requestState(row.request, issues, projects),
    }));
  });
  protected readonly requestFilters = computed(() => {
    const rows = this.rows();
    return [
      { id: 'all' as const, label: 'All', count: rows.length },
      { id: 'open' as const, label: 'Waiting', count: rows.filter((r) => r.state === 'open').length },
      { id: 'delivered' as const, label: 'Delivered', count: rows.filter((r) => r.state === 'delivered').length },
      { id: 'important' as const, label: 'Important', count: rows.filter((r) => r.request.important).length },
    ];
  });
  protected readonly visibleRows = computed(() => {
    const f = this.requestFilter();
    return this.rows().filter((r) => (f === 'all' ? true : f === 'important' ? r.request.important : r.state === f));
  });

  protected readonly work = computed(() => {
    const c = this.customer();
    return c ? sortWork(workRows(c.id, this.store.customerRequests(), this.store.issueById(), this.store.projectById())) : [];
  });
  protected readonly workBuckets = computed(() => groupWork(this.work(), this.workGroup()));
  protected readonly activity = computed(() => {
    const c = this.customer();
    return c ? customerActivity(c.id, this.store.events(), this.store.customerRequests(), this.store.issueById(), this.store.projectById()) : [];
  });
  protected readonly tabList = computed<{ id: Tab; label: string; count: number | null }[]>(() => [
    { id: 'requests', label: 'Requests', count: this.rows().length },
    { id: 'work', label: 'Work', count: this.work().length },
    { id: 'activity', label: 'Activity', count: null },
    { id: 'details', label: 'Details', count: null },
  ]);

  private readonly _crumbs = usePageCrumbs(() => {
    const c = this.customer();
    return c ? [{ label: 'Customers', link: ['/', this.slug(), 'customers'] }, { label: c.name }] : [];
  });

  protected lower(text: string): string {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  protected projectDot(status: string): string {
    return PROJECT_STATUS_META[status as keyof typeof PROJECT_STATUS_META]?.dot ?? 'bg-status-draft';
  }

  /** The heading of one work group. */
  protected workLabel(key: string): string {
    switch (this.workGroup()) {
      case 'state': return STATE_LABEL[key as RequestState] ?? key;
      case 'priority': return PRIORITY_LABEL[key as Priority] ?? key;
      case 'team': return key ? (this.store.getTeam(key)?.name ?? 'Unknown team') : 'No team';
      case 'kind': return key === 'project' ? 'Projects' : 'Issues';
      case 'status': return ISSUE_STATUS_META[key as keyof typeof ISSUE_STATUS_META]?.label ?? PROJECT_STATUS_META[key as keyof typeof PROJECT_STATUS_META]?.label ?? key;
    }
  }

  protected addRequest(): void {
    const c = this.customer();
    if (c) this.ui.openCustomerDialog({ kind: 'request', customerId: c.id });
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const c = this.customer();
    if (!c) return;
    const data = new FormData(event.target as HTMLFormElement);
    const name = String(data.get('name') ?? '').trim();
    const { domains, invalid } = normalizeCustomerDomains(splitDomains(String(data.get('domains') ?? '')));
    if (invalid.length || domains.length === 0) {
      this.formError.set(invalid.length ? `"${invalid[0]}" is not a domain. Use domains like acme.com.` : 'Add at least one domain like acme.com.');
      return;
    }
    const logo = String(data.get('logoUrl') ?? '').trim();
    if (logo && !normalizeHttpUrl(logo)) {
      this.formError.set('The logo must be an http(s) URL.');
      return;
    }
    const revenue = this.wholeNumber(data.get('revenue'));
    const size = this.wholeNumber(data.get('size'));
    if (revenue === undefined || size === undefined) {
      this.formError.set('Revenue and size must be whole numbers, 0 or more.');
      return;
    }
    this.formError.set('');
    await this.store.updateCustomer(c.id, {
      name,
      domains,
      logoUrl: logo || null,
      revenue,
      size,
      tierId: String(data.get('tierId') ?? '') || null,
      status: String(data.get('status') ?? 'active') as CustomerStatus,
    });
  }

  /** `null` for an empty field (clears it), `undefined` for something that is not a whole number >= 0. */
  private wholeNumber(raw: FormDataEntryValue | null): number | null | undefined {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  protected safeSource(request: CustomerRequest): string | null {
    return request.sourceUrl ? normalizeHttpUrl(request.sourceUrl) : null;
  }

  protected toggleImportant(request: CustomerRequest): void {
    void this.store.updateCustomerRequest(request.customerId, request.id, { important: !request.important });
  }

  protected startEdit(request: CustomerRequest): void {
    this.editingId.set(request.id);
    this.draftBody.set(request.body ?? '');
    this.draftSource.set(request.sourceUrl ?? '');
    this.requestError.set('');
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
    this.requestError.set('');
  }

  protected async saveEdit(request: CustomerRequest): Promise<void> {
    const source = this.draftSource().trim();
    if (source && !normalizeHttpUrl(source)) {
      this.requestError.set('The source must be an http(s) link.');
      return;
    }
    const ok = await this.store.updateCustomerRequest(request.customerId, request.id, {
      body: this.draftBody().trim() || null,
      sourceUrl: source || null,
    });
    if (ok) this.cancelEdit();
  }

  protected deleteRequest(request: CustomerRequest): void {
    this.ui.setConfirmDelete({
      title: 'Delete this request?',
      description: `The ${request.issueId ? 'issue' : 'project'} stays.`,
      onConfirm: async () => {
        await this.store.deleteCustomerRequest(request.customerId, request.id);
      },
    });
  }

  protected archive(): void {
    const c = this.customer();
    if (c) void this.store.updateCustomer(c.id, { archived: !c.archivedAt });
  }

  protected remove(): void {
    const c = this.customer();
    if (!c) return;
    this.ui.setConfirmDelete({
      title: `Delete ${c.name}?`,
      description: 'The customer and its requests are removed. Issues and projects stay.',
      onConfirm: async () => {
        const ok = await this.store.deleteCustomer(c.id);
        if (ok) void this.router.navigate(['/', this.slug(), 'customers']);
      },
    });
  }
}
