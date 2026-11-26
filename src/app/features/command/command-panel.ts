import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideCircleDot,
  LucideDynamicIcon,
  LucideFlag,
  LucideListTree,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideTimer,
  type LucideIcon,
} from '@lucide/angular';
import { BrnCommand, BrnCommandInput } from '@spartan-ng/brain/command';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import type { IssueStatus } from '../../core/contracts/domain';
import { ISSUE_STATUSES, ISSUE_STATUS_META } from '../../core/meta';
import { TramaStore } from '../../core/stores/trama.store';
import { UiStore } from '../../core/stores/ui.store';
import { ALL_NAV, navForRole } from '../../layout/nav';
import { MilestoneActions } from '../milestones/milestone-actions';
import { Kbd } from '../../shared/kbd';
import { StatusIcon, type AnyStatus, type StatusEntity } from '../../shared/status';
import { fuzzyScore } from './fuzzy';
import { SearchService, type HitType, type SearchHit } from './search.service';

interface Cmd {
  id: string;
  label: string;
  /** Extra words that make the command findable. */
  keywords?: string;
  icon: LucideIcon;
  keys?: string;
  /** Status glyph instead of the icon (status page). */
  status?: AnyStatus;
  entity?: StatusEntity;
  run: () => void;
}

/** The only thing the palette searches: tasks. */
const RESULT_TYPE: HitType = 'issue';

/** Static items are fuzzy-filtered by the command; result items (value starts with \u0001) always show. */
export function commandFilter(value: string, search: string): boolean {
  return value.startsWith('\u0001') || fuzzyScore(value, search) > 0;
}

/**
 * Floating command surface (v3 · 14): 640px on desktop, its top edge at ~15.5% of the viewport (140px at 900).
 * Height comes from the panel, which grows with its rows up to a cap.
 */
export const COMMAND_DIALOG_CLASS =
  // Widths use viewport units: the CDK pane shrink-wraps its content, so a `%` width collapses to the content width.
  // Pinned to the viewport (frame 01: top 140 of 900) so the panel stays put while the list grows.
  'fixed top-[min(12vh,5rem)] sm:top-[15.5svh] left-[max(0.75rem,calc(50vw-16rem))] sm:left-[max(1rem,calc(50vw-320px))] w-[min(32rem,calc(100vw-1.5rem))] sm:w-[min(640px,calc(100vw-2rem))] max-w-none sm:max-w-none mx-0 translate-y-0 gap-0 overflow-hidden rounded-lg p-0 duration-150 data-open:slide-in-from-top-2 data-closed:slide-out-to-top-2';

/**
 * Shared body of the ⌘K palette and the `/` search dialog (Pen "Dialog · 01 Command palette"):
 * search input with the esc chip, TASKS results, ACTIONS (new task, subtask and status of the open task,
 * go to…) and a one-line foot. Results come from `GET /search` (debounced) and fall back to a client-side
 * fuzzy search over the store. The `search` mode shows the results only.
 */
@Component({
  selector: 'app-command-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, LucideDynamicIcon, NgTemplateOutlet, StatusIcon, Kbd, BrnCommandInput],
  host: { class: 'block', '(keydown)': 'onKeydown($event)' },
  template: `
    <ng-template #cmdRow let-c>
      @if (c.status) {
        <app-status-icon [status]="c.status" [entity]="c.entity ?? 'auto'" />
      } @else {
        <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
      }
      <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
      @if (c.keys) {
        <hlm-command-shortcut class="max-sm:hidden"
          ><app-kbd [keys]="c.keys"
        /></hlm-command-shortcut>
      }
    </ng-template>

    <hlm-command
      class="h-auto max-h-[min(34rem,78svh)]"
      [filter]="filter"
      [(search)]="query"
    >
      <div class="shrink-0">
        <div class="border-border flex h-[51.5px] items-center gap-3 border-b px-[18px] max-md:h-14">
          <svg
            [lucideIcon]="searchIcon"
            [size]="16"
            aria-hidden="true"
            class="text-muted-foreground shrink-0"
          ></svg>
          <input
            brnCommandInput
            data-slot="command-input"
            class="placeholder:text-faint caret-primary min-w-0 flex-1 bg-transparent text-[16px] outline-hidden"
            [placeholder]="placeholder()"
            [attr.aria-label]="placeholder()"
            enterkeyhint="search"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          />
          <button
            type="button"
            class="text-primary -mr-2 flex h-11 shrink-0 items-center px-3 text-base md:hidden"
            (mousedown)="$event.preventDefault()"
            (click)="ui.closeModal()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="bg-secondary border-border text-muted-foreground hover:text-foreground shrink-0 border px-[5px] py-px font-mono text-[10.5px] leading-[14px] max-md:hidden"
            aria-label="Close"
            (mousedown)="$event.preventDefault()"
            (click)="ui.closeModal()"
          >
            esc
          </button>
        </div>
      </div>

      <div
        *hlmCommandEmptyState
        hlmCommandEmpty
        class="text-muted-foreground flex flex-col items-center gap-1 px-6 py-10"
      >
        @if (loading()) {
          <p>Searching…</p>
        } @else if (query().trim()) {
          <p class="text-foreground">No results for “{{ query().trim() }}”</p>
        } @else {
          <p>Search tasks.</p>
        }
      </div>

      <hlm-command-list
        class="max-h-[min(26rem,calc(78svh-7.5rem))] overscroll-contain [&_[data-slot=command-item][data-selected]]:bg-hover [&_[data-slot=command-item][data-selected]]:shadow-[inset_2px_0_0_var(--primary)]"
      >
        @if (page() === 'status') {
          <hlm-command-group>
            <hlm-command-group-label>Status</hlm-command-group-label>
            @for (c of statusCommands(); track c.id) {
              <button hlmCommandItem [value]="'status ' + c.label" (selected)="exec(c)">
                <ng-container
                  [ngTemplateOutlet]="cmdRow"
                  [ngTemplateOutletContext]="{ $implicit: c }"
                />
              </button>
            }
          </hlm-command-group>
        } @else if (page() === 'milestone') {
          <hlm-command-group>
            <hlm-command-group-label>Milestone</hlm-command-group-label>
            @for (c of milestoneCommands(); track c.id) {
              <button hlmCommandItem [value]="'milestone ' + c.label" (selected)="exec(c)">
                <ng-container
                  [ngTemplateOutlet]="cmdRow"
                  [ngTemplateOutletContext]="{ $implicit: c }"
                />
              </button>
            }
          </hlm-command-group>
        } @else {
          @if (results().length) {
            <hlm-command-group>
              <hlm-command-group-label>Tasks</hlm-command-group-label>
              @for (h of results(); track h.id) {
                <button
                  hlmCommandItem
                  [value]="'\\u0001issue:' + h.id"
                  (selected)="open(h)"
                >
                  <app-status-icon [status]="statusOf(h.id)" entity="issue" />
                  <span class="min-w-0 truncate">{{ h.title }}</span>
                  @if (h.key) {
                    <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ h.key }}</span>
                  }
                  <span class="min-w-0 flex-1"></span>
                  <span
                    class="text-faint shrink-0 font-mono text-[10.5px] opacity-0 max-sm:hidden [[data-selected]_&]:opacity-100"
                    aria-hidden="true"
                    >↵</span
                  >
                </button>
              }
            </hlm-command-group>
          }

          @if (mode() === 'palette') {
            <hlm-command-group>
              <hlm-command-group-label>Actions</hlm-command-group-label>
              @for (c of actionCommands(); track c.id) {
                <button
                  hlmCommandItem
                  [value]="'action ' + c.label + ' ' + (c.keywords ?? '')"
                  (selected)="exec(c)"
                >
                  <ng-container
                    [ngTemplateOutlet]="cmdRow"
                    [ngTemplateOutletContext]="{ $implicit: c }"
                  />
                </button>
              }
            </hlm-command-group>
          }
        }
      </hlm-command-list>

      <!-- foot: 33px, hints in mono 10.5 faint, what is searched on the right -->
      <div
        class="border-border text-faint flex h-[33.5px] shrink-0 items-center gap-4 border-t px-[18px] font-mono text-[10.5px] max-sm:hidden"
      >
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span class="flex-1"></span>
        <span>{{ loading() ? 'Searching…' : 'Searches tasks' }}</span>
      </div>
    </hlm-command>
  `,
})
export class CommandPanel {
  readonly mode = input<'palette' | 'search'>('palette');

  protected readonly ui = inject(UiStore);
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly searchSvc = inject(SearchService);
  private readonly milestoneActions = inject(MilestoneActions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly command = viewChild(BrnCommand);

  protected readonly filter = commandFilter;
  protected readonly searchIcon = LucideSearch;

  protected readonly query = signal('');
  protected readonly page = signal<'root' | 'status' | 'milestone'>('root');
  protected readonly loading = signal(false);
  private readonly remote = signal<{ q: string; hits: SearchHit[] } | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;

  private readonly slug = computed(() => this.store.slug() ?? '');

  protected readonly placeholder = computed(() => {
    if (this.page() === 'status') return 'Set status…';
    if (this.page() === 'milestone') return 'Set milestone…';
    return this.mode() === 'palette' ? 'Type a command or search…' : 'Search tasks…';
  });

  // ─────────────────────────── results ───────────────────────────

  protected readonly results = computed<SearchHit[]>(() => {
    const q = this.query().trim();
    if (!q || this.page() !== 'root') return [];
    const r = this.remote();
    if (r && r.q === q && r.hits.length) return r.hits.filter((h) => h.type === RESULT_TYPE);
    // Remote still pending / failed / empty: show what the snapshot knows right now.
    return this.searchSvc.local(q, 8, RESULT_TYPE);
  });

  protected statusOf(id: string): AnyStatus {
    return this.store.issueById().get(id)?.status ?? 'backlog';
  }

  // ─────────────────────────── context (open task) ───────────────────────────

  /** The task whose page is open, from the router URL. */
  private readonly context = computed(() => {
    const path = this.router.url.split(/[?#]/)[0].split('/').filter(Boolean);
    if (path.length < 3 || (path[1] !== 'tasks' && path[1] !== 'issues')) return null;
    return this.store.getIssue(decodeURIComponent(path[2])) ?? null;
  });

  protected readonly statusCommands = computed<Cmd[]>(() => {
    const issue = this.context();
    if (!issue) return [];
    return ISSUE_STATUSES.map((s: IssueStatus) => ({
      id: 'st:' + s,
      label: ISSUE_STATUS_META[s].label,
      icon: LucideCircleDot,
      status: s as AnyStatus,
      entity: 'issue' as StatusEntity,
      run: () => {
        if (s !== issue.status) void this.store.updateIssue(issue.id, { status: s });
        this.ui.closeModal();
      },
    }));
  });

  protected readonly milestoneCommands = computed<Cmd[]>(() => {
    const issue = this.context();
    const projectId = issue?.projectId;
    if (!issue || !projectId) return [];
    const current = this.milestoneActions.milestoneOf(issue, projectId)?.id ?? null;
    const pick = (id: string | null) => () => {
      if (id !== current) this.milestoneActions.assign(issue, projectId, id);
      this.ui.closeModal();
    };
    const rows: Cmd[] = (this.store.milestonesByProject().get(projectId) ?? []).map((m, i) => ({
      id: 'ms:' + m.id,
      label: m.id === current ? `${m.name} (current)` : m.name,
      keywords: `M${i + 1}`,
      icon: LucideFlag,
      run: pick(m.id),
    }));
    if (current) rows.push({ id: 'ms:none', label: 'No milestone', icon: LucideFlag, run: pick(null) });
    return rows;
  });

  // ─────────────────────────── commands ───────────────────────────

  protected readonly actionCommands = computed<Cmd[]>(() => {
    const slug = this.slug();
    const go =
      (...path: string[]) =>
      () =>
        void this.router.navigate(['/', slug, ...path]);
    const out: Cmd[] = [];
    if (this.store.allowed('createIssues'))
      out.push({
        id: 'new:issue',
        label: 'New task',
        keywords: 'create bug feature incident report',
        icon: LucidePlus,
        keys: 'c',
        run: () => this.ui.openCreate('issue'),
      });
    const issue = this.context();
    if (issue && this.store.can('member')) {
      if (this.store.allowed('createIssues'))
        out.push({
          id: 'ctx:subtask',
          label: `New subtask in ${issue.key}`,
          keywords: 'create child',
          icon: LucideListTree,
          run: () =>
            this.ui.openCreate('issue', { parentId: issue.id, projectId: issue.projectId }),
        });
      out.push({
        id: 'ctx:status',
        label: 'Set status…',
        keywords: 'state move change',
        icon: LucideCircleDot,
        keys: 's',
        run: () => this.openPage('status'),
      });
      // The task page in the designs shows no milestone field: the palette is where a task joins one.
      if (issue.projectId && this.store.milestonesByProject().get(issue.projectId)?.length)
        out.push({
          id: 'ctx:milestone',
          label: 'Set milestone…',
          keywords: 'milestone phase release',
          icon: LucideFlag,
          run: () => this.openPage('milestone'),
        });
    }
    for (const n of navForRole(ALL_NAV, this.store.isGuest()))
      out.push({
        id: 'nav:' + n.segment,
        label: `Go to ${n.label}`,
        keywords: n.keywords,
        icon: n.icon,
        keys: n.keys || undefined,
        run: go(n.segment),
      });
    // Time reports and estimates have no visible link in the designs: the palette is how you get there.
    if (!this.store.isGuest()) {
      for (const [sub, label, keywords] of [
        ['reports', 'Time reports', 'hours tracked chart billable'],
        ['estimates', 'Time estimates', 'points actual accuracy'],
      ] as const)
        out.push({
          id: 'nav:timer-' + sub,
          label: `Go to ${label}`,
          keywords,
          icon: LucideTimer,
          run: () => void this.router.navigate(['/', slug, 'timer', sub]),
        });
    }
    out.push({
      id: 'nav:settings',
      label: 'Go to Settings',
      icon: LucideSettings,
      keys: 'g s',
      run: () =>
        void this.router.navigate(['/', slug, 'settings', this.store.isGuest() ? 'profile' : 'workspace']),
    });
    return out;
  });

  constructor() {
    effect(() => {
      const q = this.query().trim();
      untracked(() => this.schedule(q));
    });
  }

  // ─────────────────────────── keyboard ───────────────────────────

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Backspace' && !this.query() && this.page() !== 'root') {
      e.preventDefault();
      this.backToRoot();
      return;
    }
    if (e.key === 'Escape' && this.page() !== 'root') {
      // Keep the palette open: go back to the root page instead of closing.
      e.preventDefault();
      e.stopPropagation();
      this.backToRoot();
    }
  }

  private setQuery(value: string): void {
    this.query.set(value);
    // The command's `search` is a model; push the value so the input reflects it immediately.
    this.command()?.search.set(value);
  }

  private openPage(page: 'status' | 'milestone'): void {
    this.page.set(page);
    this.setQuery('');
    this.focusInput();
  }

  protected backToRoot(): void {
    this.page.set('root');
    this.setQuery('');
    this.focusInput();
  }

  private focusInput(): void {
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus());
  }

  private schedule(q: string): void {
    clearTimeout(this.timer);
    const gen = ++this.gen;
    if (q.length < 2 || this.page() !== 'root') {
      this.remote.set(null);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.timer = setTimeout(async () => {
      try {
        const hits = await this.searchSvc.remote(q, 24, [RESULT_TYPE]);
        if (gen === this.gen) this.remote.set({ q, hits });
      } catch {
        if (gen === this.gen) this.remote.set(null); // offline / endpoint missing: local results stay
      } finally {
        if (gen === this.gen) this.loading.set(false);
      }
    }, 180);
  }

  // ─────────────────────────── actions ───────────────────────────

  protected exec(c: Cmd): void {
    const before = this.ui.modal();
    const page = this.page();
    c.run();
    // Nested pages and create / search / shortcuts manage the modal themselves; otherwise close.
    if (this.page() !== page) return;
    if (this.ui.modal() === before) this.ui.closeModal();
  }

  protected open(h: SearchHit): void {
    const slug = this.slug();
    if (!slug) return;
    this.ui.closeModal();
    void this.router.navigate(['/', slug, ...this.searchSvc.path(h)], {
      queryParams: this.searchSvc.queryParams(h),
    });
  }
}
