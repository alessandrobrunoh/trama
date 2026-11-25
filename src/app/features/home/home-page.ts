import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCornerDownRight,
  LucideDynamicIcon,
  LucideEye,
  LucideGitPullRequest,
  LucideLink2Off,
  LucideTriangleAlert,
  type LucideIconInput,
} from '@lucide/angular';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { TramaStore, relativeTime, statusTypeOf, type Artifact, type Issue } from '../../core';
import { usePageShortcuts } from '../../core/keyboard';
import { SessionStore } from '../../core/session/session.store';
import { UiStore } from '../../core/stores/ui.store';
import { PageHeader } from '../../shared/page-header';
import { Kbd } from '../../shared/kbd';
import { V3SectionTitle, V3Status, V3Thread } from '../../shared/v3';
import { HlmButton } from '@spartan-ng/helm/button';
import { dailyFlow, weekTotals } from './flow-model';
import { HomeFlow } from './home-flow';

/** One "Working on now" card: an in-progress or in-review task of mine. */
interface FocusCard {
  issue: Issue;
  projectName: string;
  projectColor: string;
  subtasks: { done: number; total: number; threaded: number };
  pr?: Artifact;
  next: { icon: LucideIconInput; text: string };
  due?: { text: string; urgent: boolean };
  record?: { id: string; text: string; at?: string };
}

/** One "Needs you" row: something only the reader can do. */
interface NeedRow {
  id: string;
  icon: LucideIconInput;
  tone: string;
  title: string;
  detail: string;
  action: string;
  keys: string;
  run: () => void;
}

const OPEN_PR_STATES = new Set(['draft', 'open']);

/** "due today", "due tomorrow", "due in 3 days", "overdue 2 days". */
function dueText(iso: string | undefined, now: Date): { text: string; urgent: boolean } | undefined {
  if (!iso) return undefined;
  const days = differenceInCalendarDays(parseISO(iso), now);
  if (days < 0) return { text: `overdue ${-days} day${days === -1 ? '' : 's'}`, urgent: true };
  if (days === 0) return { text: 'due today', urgent: true };
  if (days === 1) return { text: 'due tomorrow', urgent: true };
  return { text: `due in ${days} days`, urgent: false };
}

/** "th_8f2a19" from a Delta thread URL (its last path segment, shortened). */
function threadId(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return seg.length > 12 ? `th_${seg.slice(-6)}` : seg || 'thread';
  } catch {
    return 'thread';
  }
}

/**
 * `/:workspace/overview` (Home, v3 · 02): a personal start page. What I am working on now, with each task's Delta
 * thread record; what is next for me by due date; the few things only I can do; and the last four weeks of the
 * workspace (tasks closed against opened). Status is always moved by people.
 *
 * Keyboard: J/K (or ↑/↓) move through cards and rows, ↵ opens the focused task or runs its Open, and each "Needs you"
 * key (⇧R, D, ?) runs the action of the focused row; ↵, ⇧R and D fall back to the first row offering them. `?` without
 * a focused "How" row still opens the shortcuts list.
 */
@Component({
  selector: 'app-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, HomeFlow, Kbd, LucideDynamicIcon, PageHeader, RouterLink, V3SectionTitle, V3Status, V3Thread],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header title="Home" />

    <div class="flex flex-col gap-[26px] px-4 pt-7 pb-10 sm:px-10">
      <!-- greeting -->
      <header class="flex flex-col gap-1.5">
        <p class="font-title text-muted-foreground text-[14px] leading-[14px] italic">{{ dateLine() }}</p>
        <h1 class="font-title text-foreground text-[34px] leading-[36px] tracking-[-0.5px]">{{ greeting() }}</h1>
        <p class="text-muted-foreground text-[14px] leading-4">{{ summary() }}</p>
      </header>

      <!-- working on now -->
      <section class="flex flex-col gap-3" aria-label="Working on now">
        <v3-section-title title="Working on now" caption="your tasks in progress or in review" />
        @if (cards().length) {
          <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
            @for (c of cards(); track c.issue.id) {
              <article
                class="bg-card flex min-w-0 flex-col gap-4 border p-[22px]"
                [class]="focused() === 'card:' + c.issue.id ? 'border-border-strong' : 'border-border'"
                [attr.data-row-id]="'card:' + c.issue.id"
              >
                <div class="flex items-center gap-2.5 font-mono text-[11px] leading-[14px]">
                  <span class="text-muted-foreground">{{ c.issue.key }}</span>
                  @if (c.projectName) {
                    <span class="size-2 shrink-0" [style.background]="c.projectColor" aria-hidden="true"></span>
                    <span class="text-faint truncate">{{ c.projectName }}</span>
                  }
                  <span class="flex-1"></span>
                  <v3-status [status]="c.issue.status" />
                </div>
                <a
                  class="font-title text-foreground text-[24px] leading-[24px] hover:underline hover:decoration-1 hover:underline-offset-4"
                  [routerLink]="['/', slug(), 'tasks', c.issue.key]"
                  >{{ c.issue.title }}</a
                >
                <div class="flex flex-col gap-1.5">
                  <div class="flex gap-2 font-mono text-[10.5px] leading-[13px] uppercase">
                    <span class="text-foreground">
                      @if (c.subtasks.total) {
                        Subtasks · {{ c.subtasks.done }} of {{ c.subtasks.total }} done
                      } @else {
                        No subtasks
                      }
                    </span>
                    <span class="flex-1"></span>
                    @if (c.subtasks.total) {
                      <span class="text-faint normal-case">{{ c.subtasks.threaded }} with their own thread</span>
                    } @else if (c.pr) {
                      <span class="text-faint normal-case">PR {{ prLabel(c.pr) }}</span>
                    }
                  </div>
                  <div class="bg-secondary h-1">
                    <div class="bg-status-done h-1" [style.width.%]="c.subtasks.total ? (c.subtasks.done / c.subtasks.total) * 100 : 0"></div>
                  </div>
                </div>
                @if (c.record; as r) {
                  <div class="border-delta-line bg-delta-line/5 flex flex-col gap-1.5 border px-3.5 py-2.5">
                    <div class="flex gap-2 font-mono text-[10px] leading-[13px]">
                      <span class="text-delta">DELTA THREAD</span>
                      <span class="text-faint">{{ r.id }}</span>
                      <span class="flex-1"></span>
                      @if (r.at) {
                        <span class="text-faint">recorded {{ ago(r.at) }}</span>
                      }
                    </div>
                    <p class="line-clamp-2 text-[13px] leading-[18px] text-[#c9cbcf]">{{ r.text }}</p>
                  </div>
                } @else {
                  <div class="border-border flex flex-col gap-1.5 border border-dashed px-3.5 py-2.5">
                    <span class="text-faint font-mono text-[10px] leading-[13px]">NO DELTA THREAD</span>
                    <p class="text-muted-foreground text-[13px] leading-[18px]">
                      Run <span class="text-foreground font-mono text-[12px]">/trama {{ c.issue.key }}</span> in a Delta thread to link it.
                    </p>
                  </div>
                }
                <div class="flex items-center gap-2.5">
                  <svg [lucideIcon]="c.next.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  <span class="text-foreground min-w-0 truncate text-[13px] leading-[18px]">{{ c.next.text }}</span>
                  <span class="flex-1"></span>
                  @if (c.due; as d) {
                    <span class="font-mono text-[10.5px] whitespace-nowrap" [class]="d.urgent ? 'text-red' : 'text-muted-foreground'">{{ d.text }}</span>
                  }
                  <a hlmBtn variant="outline" [routerLink]="['/', slug(), 'tasks', c.issue.key]">Open <app-kbd keys="enter" /></a>
                </div>
              </article>
            }
          </div>
        } @else {
          <div class="border-border text-muted-foreground border border-dashed px-[22px] py-6 text-[13px]">
            Nothing in progress. Pick something from Up next and move it to In progress when you start.
          </div>
        }
      </section>

      <!-- up next + needs you -->
      <div class="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section class="flex min-w-0 flex-col gap-2" aria-label="Up next">
          <v3-section-title title="Up next" caption="assigned to you · by due date" />
          <ul class="border-border border-t">
            @for (i of upNext(); track i.id) {
              <li>
                <a
                  class="border-border hover:bg-hover flex items-center gap-3.5 border-b px-1 py-[11px]"
                  [class.bg-hover]="focused() === 'next:' + i.id"
                  [attr.data-row-id]="'next:' + i.id"
                  [routerLink]="['/', slug(), 'tasks', i.key]"
                >
                  <span class="w-[58px] shrink-0 font-mono text-[10.5px] uppercase" [class]="dueTone(i)">{{ dueLabel(i) }}</span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-foreground truncate text-[13.5px] leading-[18px]">{{ i.title }}</span>
                    <span class="text-faint truncate font-mono text-[10px] leading-[12px]">{{ i.key }}{{ projectSuffix(i) }}</span>
                  </span>
                  <v3-thread [issue]="i" [label]="i.threadUrl ? 'Thread' : null" />
                </a>
              </li>
            } @empty {
              <li class="text-muted-foreground border-border border-b px-1 py-[11px] text-[13px]">Nothing else assigned to you.</li>
            }
          </ul>
        </section>

        <section class="flex min-w-0 flex-col gap-2" aria-label="Needs you">
          <v3-section-title title="Needs you" caption="things only you can do" />
          <ul class="border-border border-t">
            @for (n of needs(); track n.id) {
              <li
                class="border-border flex items-center gap-3 border-b px-1 py-2.5"
                [class.bg-hover]="focused() === 'need:' + n.id"
                [attr.data-row-id]="'need:' + n.id"
              >
                <span class="bg-card border-border flex size-7 shrink-0 items-center justify-center border">
                  <svg [lucideIcon]="n.icon" [size]="14" [class]="n.tone"></svg>
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-foreground truncate text-[13.5px] leading-[18px]">{{ n.title }}</span>
                  <span class="text-faint truncate text-[12px] leading-[15px]">{{ n.detail }}</span>
                </span>
                <button hlmBtn variant="outline" type="button" (click)="n.run()">{{ n.action }} <app-kbd [keys]="n.keys" /></button>
              </li>
            } @empty {
              <li class="text-muted-foreground border-border border-b px-1 py-2.5 text-[13px]">Nothing needs you right now.</li>
            }
          </ul>
        </section>
      </div>

      <!-- the workspace, last four weeks -->
      <section class="flex flex-col gap-3" aria-label="Last four weeks">
        <v3-section-title title="Last four weeks" [caption]="flowCaption()" />
        <app-home-flow [days]="flow()" [weeks]="weeks()" [slug]="slug()" />
      </section>
    </div>
  `,
})
export class HomePage {
  protected readonly store = inject(TramaStore);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly ui = inject(UiStore);

  /** Refreshed every minute so "due" and "recorded" stay current. */
  protected readonly now = signal(new Date());
  /** The card or row J/K focused (`card:<id>`, `next:<id>`, `need:<id>`). */
  protected readonly focused = this.ui.focusedRowId;

  constructor() {
    // Start without a focused row, so keys never act on a row picked on an earlier visit.
    this.ui.setFocusedRow(null);
    const tick = setInterval(() => this.now.set(new Date()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));

    usePageShortcuts([
      {
        keys: 'enter',
        label: 'Run Open on the focused row',
        when: () => !!this.needFor('enter', false),
        run: () => this.needFor('enter', false)!.run(),
      },
      {
        keys: 'shift+r',
        label: 'Move the task with an open PR to In review',
        when: () => !!this.needFor('shift+r', true),
        run: () => this.needFor('shift+r', true)!.run(),
      },
      {
        keys: 'd',
        label: 'Open the details of a CI failure or conflict',
        when: () => !!this.needFor('d', true),
        run: () => this.needFor('d', true)!.run(),
      },
      {
        keys: '?',
        label: 'How to link a thread (focused row)',
        when: () => !!this.needFor('?', false),
        run: () => this.needFor('?', false)!.run(),
      },
    ]);
  }

  /**
   * The "Needs you" row a key acts on: the focused row when it offers that key; with no "Needs you" row focused,
   * and when `fallback`, the first row offering it.
   */
  private needFor(keys: string, fallback: boolean): NeedRow | undefined {
    const focused = this.focused();
    const rows = this.needs();
    const current = rows.find((n) => `need:${n.id}` === focused);
    if (current) return current.keys === keys ? current : undefined;
    return fallback ? rows.find((n) => n.keys === keys) : undefined;
  }

  protected readonly flow = computed(() => {
    const statuses = this.store.settings().statuses;
    return dailyFlow({
      now: this.now(),
      issues: this.store.issues(),
      projects: this.store.projects(),
      milestones: this.store.milestones(),
      issueType: (s) => statusTypeOf(statuses.issue, s),
      projectType: (s) => statusTypeOf(statuses.project, s),
    });
  });
  protected readonly weeks = computed(() => weekTotals(this.flow()));
  protected readonly flowCaption = computed(() => {
    const closed = this.flow().reduce((n, d) => n + d.closed, 0);
    const opened = this.flow().reduce((n, d) => n + d.created, 0);
    return `workspace · ${closed} closed · ${opened} opened`;
  });

  protected readonly slug = computed(() => this.store.workspace()?.slug ?? '');
  private readonly typeOf = (i: Issue) => statusTypeOf(this.store.settings().statuses.issue, i.status) ?? i.status;

  /** My open tasks (not draft / done / canceled). */
  private readonly mine = computed(() => {
    const me = this.session.user()?.id;
    if (!me) return [];
    return this.store
      .issues()
      .filter((i) => i.assigneeId === me && !['draft', 'done', 'canceled'].includes(this.typeOf(i)));
  });

  private readonly working = computed(() =>
    this.mine()
      .filter((i) => ['in_progress', 'in_review'].includes(this.typeOf(i)))
      .sort((a, b) =>
        this.typeOf(a) !== this.typeOf(b)
          ? this.typeOf(a) === 'in_progress'
            ? -1
            : 1
          : b.updatedAt.localeCompare(a.updatedAt),
      ),
  );

  private readonly childrenOf = computed(() => {
    const map = new Map<string, Issue[]>();
    for (const i of this.store.issues()) {
      if (!i.parentId) continue;
      const list = map.get(i.parentId) ?? [];
      list.push(i);
      map.set(i.parentId, list);
    }
    return map;
  });

  private openPr(issue: Issue): Artifact | undefined {
    return (this.store.artifactsByIssue().get(issue.id) ?? []).find(
      (a) => (a.kind === 'pull_request' || a.kind === 'merge_request') && OPEN_PR_STATES.has(a.state),
    );
  }

  protected readonly cards = computed<FocusCard[]>(() => {
    const now = this.now();
    const projects = this.store.projectById();
    const comments = this.store.commentsBySubject();
    return this.working()
      .slice(0, 2)
      .map((issue) => {
        const project = issue.projectId ? projects.get(issue.projectId) : undefined;
        const kids = (this.childrenOf().get(issue.id) ?? []).filter((k) => this.typeOf(k) !== 'canceled');
        const done = kids.filter((k) => this.typeOf(k) === 'done').length;
        const nextKid = kids
          .filter((k) => this.typeOf(k) !== 'done')
          .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.number - b.number)[0];
        const inReview = this.typeOf(issue) === 'in_review';
        const pr = this.openPr(issue);
        const latest = (comments.get(`issue:${issue.id}`) ?? []).at(-1);
        return {
          issue,
          projectName: project?.name ?? '',
          projectColor: project?.color ?? '#8c9096',
          subtasks: { done, total: kids.length, threaded: kids.filter((k) => !!k.threadUrl).length },
          pr,
          next: inReview
            ? { icon: LucideEye, text: pr ? `Waiting for review on PR ${this.prLabel(pr)}` : 'Waiting for review' }
            : nextKid
              ? { icon: LucideCornerDownRight, text: `Next: ${nextKid.key} ${nextKid.title}` }
              : { icon: LucideCornerDownRight, text: pr ? 'PR open: move it to In review when ready' : 'No open subtasks' },
          due: dueText(nextKid?.dueDate ?? issue.dueDate, now),
          record: issue.threadUrl
            ? {
                id: threadId(issue.threadUrl),
                text: latest ? latest.body.replace(/\s+/g, ' ').slice(0, 220) : 'Linked. The record fills in on the next trama sync.',
                at: latest?.createdAt,
              }
            : undefined,
        };
      });
  });

  protected readonly upNext = computed(() => {
    const working = new Set(this.working().map((i) => i.id));
    return this.mine()
      .filter((i) => !working.has(i.id) && !i.parentId)
      .sort(
        (a, b) =>
          (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, 5);
  });

  protected readonly needs = computed<NeedRow[]>(() => {
    const rows: NeedRow[] = [];
    for (const issue of this.working()) {
      if (this.typeOf(issue) !== 'in_progress') continue;
      if (this.openPr(issue)) {
        rows.push({
          id: `pr:${issue.id}`,
          icon: LucideGitPullRequest,
          tone: 'text-status-done',
          title: `${issue.key} has an open PR`,
          detail: "Move it to In review when you're ready.",
          action: 'Move',
          keys: 'shift+r',
          run: () => void this.store.updateIssue(issue.id, { status: 'in_review' }),
        });
      }
      if (!issue.threadUrl) {
        rows.push({
          id: `thread:${issue.id}`,
          icon: LucideLink2Off,
          tone: 'text-status-in-progress',
          title: `${issue.key} is in progress without a thread`,
          detail: `Run /trama ${issue.key} in its Delta thread to link it.`,
          action: 'How',
          keys: '?',
          run: () => void this.router.navigate(['/', this.slug(), 'connect']),
        });
      }
    }
    for (const a of this.store.openAttention()) {
      const issue = a.issueId ? this.store.issueById().get(a.issueId) : undefined;
      const review = a.kind === 'review_requested';
      rows.push({
        id: a.id,
        icon: review ? LucideEye : LucideTriangleAlert,
        tone: review ? 'text-delta-line' : 'text-status-in-progress',
        title: a.title,
        detail: issue ? `${issue.key} · ${issue.title}` : a.detail,
        action: review ? 'Open' : 'Details',
        keys: review ? 'enter' : 'd',
        run: () =>
          void this.router.navigate(issue ? ['/', this.slug(), 'tasks', issue.key] : ['/', this.slug(), 'inbox']),
      });
    }
    return rows.slice(0, 5);
  });

  protected readonly dateLine = computed(() => format(this.now(), 'EEEE, MMMM d'));

  protected readonly greeting = computed(() => {
    const h = this.now().getHours();
    const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    const first = this.session.user()?.name?.split(/\s+/)[0];
    return first ? `Good ${part}, ${first}.` : `Good ${part}.`;
  });

  protected readonly summary = computed(() => {
    const now = this.now();
    const working = this.working().filter((i) => this.typeOf(i) === 'in_progress').length;
    const dueWeek = this.mine().filter((i) => {
      if (!i.dueDate) return false;
      return differenceInCalendarDays(parseISO(i.dueDate), now) <= 7;
    }).length;
    const needs = this.needs().length;
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return [
      plural(working, 'task in progress', 'tasks in progress'),
      `${dueWeek} due this week`,
      plural(needs, 'thing needs you', 'things need you'),
    ].join(' · ');
  });

  protected prLabel(pr: Artifact): string {
    const repo = pr.repository && !pr.repository.includes('://') ? pr.repository : '';
    const id = pr.externalId ?? '';
    return repo ? `${repo}${id.startsWith('#') || id.startsWith('!') ? id : `#${id}`}` : id || pr.title;
  }

  protected dueLabel(i: Issue): string {
    if (!i.dueDate) return '—';
    const days = differenceInCalendarDays(parseISO(i.dueDate), this.now());
    if (days < 0) return 'Overdue';
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return format(parseISO(i.dueDate), 'MMM dd');
  }

  protected dueTone(i: Issue): string {
    if (!i.dueDate) return 'text-faint';
    return differenceInCalendarDays(parseISO(i.dueDate), this.now()) <= 0 ? 'text-red' : 'text-muted-foreground';
  }

  protected projectSuffix(i: Issue): string {
    const p = i.projectId ? this.store.projectById().get(i.projectId) : undefined;
    return p ? ` · ${p.name}` : '';
  }

  protected ago(iso: string): string {
    return relativeTime(iso);
  }
}
