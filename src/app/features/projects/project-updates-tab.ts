// The Updates tab of a project (v3 "App · 10 Project · Updates"): the latest written update as the headline, the
// scope and risk chart, the key events of the current milestone (what happened, where scope changed, the pull
// requests), the closed milestones folded to a line each, and a rail with where things stand, who is active,
// the next milestone and the Post update / Export as changelog actions.
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBookOpen, LucideChevronRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  resolveStatusEntry,
  statusTypeOf,
  type ActorRef,
  type Project,
  type ProjectUpdate,
} from '../../core/contracts/domain';
import { TramaStore } from '../../core/stores/trama.store';
import { ago } from '../../shared/ago';
import { ActorAvatar } from '../../shared/actor-avatar';
import { dayOf, totalsOf, usesPoints } from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import type { MilestoneState } from '../milestones/milestone-model';
import { ProjectBurnup } from './project-burnup';
import { ProjectUpdateDialog } from './project-update-dialog';
import {
  castOf,
  changelogMarkdown,
  closedDayOf,
  deriveKeyEvents,
  firstParagraph,
  milestoneWindows,
  recapOf,
  restOfBody,
  shortDate,
  shortDay,
  type KeyEvent,
  type UpdatesContext,
} from './project-updates-model';
import { ProjectUpdatesStore } from './project-updates.store';

const STATE_LABEL: Record<MilestoneState, string> = {
  done: 'CLOSED',
  active: 'IN PROGRESS',
  overdue: 'OVERDUE',
  idle: 'NOT STARTED',
  empty: 'NO TASKS',
};

const EVENT_CAP = 8;
const CAST_CAP = 6;

/** The key events of one milestone: date, who, what, and the task on the right. */
@Component({
  selector: 'app-project-key-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ActorAvatar, HlmButtonImports],
  host: { class: 'flex w-full flex-col' },
  template: `
    @for (e of shown(); track e.id) {
      @let hot = !!e.kicker;
      <div
        class="border-border flex items-start gap-3.5 border-b border-l-2 py-[11px] pr-3.5 pl-[13px] last:border-b-0"
        [class]="hot ? 'bg-primary/10 border-l-primary' : 'border-l-transparent'"
      >
        <span class="text-faint w-[52px] shrink-0 font-mono text-[11px] leading-[19px] whitespace-nowrap">{{ date(e) }}</span>
        <app-actor-avatar class="mt-px" [actor]="e.actor" [size]="20" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          @if (e.kicker) {
            <span class="text-primary font-mono text-[9.5px] leading-[normal]">{{ e.kicker }}</span>
          }
          <p
            class="m-0 line-clamp-3 text-[13px] leading-[19px] [overflow-wrap:anywhere]"
            [class]="hot ? 'text-foreground' : 'text-text-2'"
          >
            {{ e.text }}
          </p>
        </div>
        @if (e.ref) {
          <a
            class="text-faint hover:text-foreground shrink-0 font-mono text-[10.5px] leading-[19px] outline-none focus-visible:underline"
            [routerLink]="['/', slug(), 'tasks', e.ref]"
            >{{ e.ref }}</a
          >
        }
      </div>
    } @empty {
      <p class="text-faint m-0 py-3 font-mono text-[11px]">No key events yet.</p>
    }
    @if (events().length > cap && !all()) {
      <button
        hlmBtn
        variant="ghost"
        size="sm"
        class="text-muted-foreground mt-1 self-start font-mono text-[11px]"
        (click)="all.set(true)"
      >
        Show all {{ events().length }} events
      </button>
    }
  `,
})
export class ProjectKeyEvents {
  readonly events = input.required<readonly KeyEvent[]>();
  readonly slug = input.required<string>();

  protected readonly cap = EVENT_CAP;
  protected readonly all = signal(false);
  protected readonly shown = computed(() => (this.all() ? this.events() : this.events().slice(0, EVENT_CAP)));

  protected date(e: KeyEvent): string {
    return shortDate(e.at);
  }
}

interface Section {
  id: string;
  title: string;
  meta: string;
  done: number;
  total: number;
  events: KeyEvent[];
}

interface PastSection {
  id: string;
  title: string;
  meta: string;
  recap: string;
  events: KeyEvent[];
}

@Component({
  selector: 'app-project-updates-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    LucideDynamicIcon,
    ActorAvatar,
    ProjectBurnup,
    ProjectKeyEvents,
    ProjectUpdateDialog,
  ],
  host: { class: 'flex min-w-0 flex-1 max-lg:flex-col' },
  template: `
    @let p = project();
    <div class="flex min-w-0 flex-1 flex-col gap-[22px] px-4 py-[22px] sm:px-10">
      <section class="flex flex-col gap-2" aria-label="Summary">
        @if (latest(); as u) {
          <span class="text-faint font-mono text-[10.5px] leading-[normal] uppercase">
            Summary · posted by {{ authorName(u) }} · {{ postedOn(u) }}
          </span>
          <h2 class="font-title text-foreground m-0 line-clamp-4 text-[24px] leading-[31px] font-normal tracking-[-0.3px]">
            {{ headline() }}
          </h2>
        } @else {
          <span class="text-faint font-mono text-[10.5px] leading-[normal] uppercase">Summary</span>
          <h2 class="font-title text-muted-foreground m-0 text-[24px] leading-[31px] font-normal tracking-[-0.3px]">
            No update has been posted for {{ p.name }} yet.
          </h2>
          @if (store.failed()) {
            <p class="text-faint m-0 font-mono text-[11px]">Updates could not be loaded.</p>
          }
        }
      </section>

      <app-project-burnup [project]="p" [scopeRisk]="true" />

      @if (section(); as s) {
        <section class="flex flex-col gap-3" [attr.aria-label]="s.title">
          <div class="flex flex-wrap items-end gap-x-3.5 gap-y-1">
            <h3 class="font-title text-foreground m-0 text-[22px] leading-[normal] font-normal tracking-[-0.3px]">{{ s.title }}</h3>
            <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ s.meta }}</span>
            <span class="min-w-0 flex-1"></span>
            @if (s.total) {
              <span class="text-muted-foreground font-mono text-[10.5px] leading-[normal]">
                key events · {{ s.done }} of {{ s.total }} {{ s.total === 1 ? 'task' : 'tasks' }} done
              </span>
            }
          </div>
          <app-project-key-events [events]="s.events" [slug]="slug()" />
        </section>
      }

      @for (m of past(); track m.id) {
        <section class="border-border flex flex-col gap-2 border-t pt-3.5" [attr.aria-label]="m.title">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              class="flex min-w-0 items-center gap-3 text-start outline-none focus-visible:underline"
              [attr.aria-expanded]="isOpen(m.id)"
              (click)="toggle(m.id)"
            >
              <svg
                [lucideIcon]="chevron"
                [size]="14"
                class="text-faint shrink-0 transition-transform"
                [class.rotate-90]="isOpen(m.id)"
                aria-hidden="true"
              ></svg>
              <span class="font-title text-text-2 truncate text-[18px] leading-[normal]">{{ m.title }}</span>
            </button>
            <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ m.meta }}</span>
            <span class="min-w-0 flex-1"></span>
            <button
              type="button"
              class="text-primary font-mono text-[10.5px] leading-[normal] outline-none hover:underline focus-visible:underline"
              (click)="toggle(m.id)"
            >
              {{ isOpen(m.id) ? 'Close recap' : 'Open recap →' }}
            </button>
          </div>
          <p class="font-title text-muted-foreground m-0 pl-[26px] text-[15px] leading-[22px] italic">{{ m.recap }}</p>
          @if (isOpen(m.id)) {
            <div class="pt-1 pl-[26px]">
              <app-project-key-events [events]="m.events" [slug]="slug()" />
            </div>
          }
        </section>
      }
    </div>

    <aside class="bg-card border-border flex shrink-0 flex-col max-lg:border-t lg:w-[300px] lg:border-l" aria-label="Where things stand">
      <section class="border-border flex flex-col gap-2.5 border-b px-5 py-4">
        <span class="text-foreground font-mono text-[10px] leading-[normal] uppercase">Where things stand</span>
        <p class="font-title text-text-2 m-0 text-[14.5px] leading-[22px] [overflow-wrap:anywhere] whitespace-pre-line">{{ standing() }}</p>
        <span class="text-faint font-mono text-[9.5px] leading-[normal]">{{ standingNote() }}</span>
      </section>

      @if (cast().length) {
        <section class="border-border flex flex-col gap-2.5 border-b px-5 py-4">
          <span class="text-foreground font-mono text-[10px] leading-[normal] uppercase">People &amp; agents</span>
          @for (c of cast(); track c.key) {
            <div class="flex items-center gap-2.5">
              <app-actor-avatar [actor]="c.actor" [size]="20" />
              <span class="text-foreground min-w-0 truncate text-[12.5px] leading-[normal]">{{ c.name }}</span>
              <span class="min-w-0 flex-1"></span>
              <span class="text-faint shrink-0 font-mono text-[10px] leading-[normal]">{{ c.note }}</span>
            </div>
          }
        </section>
      }

      @if (next(); as n) {
        <section class="border-border flex flex-col gap-2.5 border-b px-5 py-4">
          <span class="text-foreground font-mono text-[10px] leading-[normal] uppercase">Next milestone</span>
          <span class="font-title text-foreground text-[17px] leading-[normal]">{{ n.name }}</span>
          <span class="text-faint font-mono text-[10px] leading-[normal]">{{ n.meta }}</span>
          @if (n.description) {
            <p class="text-muted-foreground m-0 line-clamp-4 text-[12.5px] leading-[18px]">{{ n.description }}</p>
          }
        </section>
      }

      <section class="flex flex-col gap-2 px-5 py-4">
        @if (canPost()) {
          <button
            type="button"
            class="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 flex w-full items-center justify-center gap-2 px-3 py-2 text-[12.5px] leading-[normal] font-medium outline-none focus-visible:ring-2"
            (click)="post()"
          >
            <svg [lucideIcon]="bookIcon" [size]="14" aria-hidden="true"></svg>
            Post update
          </button>
        }
        <button
          type="button"
          class="border-border text-text-2 hover:bg-hover focus-visible:ring-ring/50 flex w-full items-center justify-center border px-3 py-2 text-[12.5px] leading-[normal] outline-none focus-visible:ring-2"
          (click)="exportChangelog()"
        >
          Export as changelog
        </button>
      </section>
    </aside>

    @if (canPost()) {
      <app-project-update-dialog [project]="p" [(open)]="dialogOpen" />
    }
  `,
})
export class ProjectUpdatesTab {
  readonly project = input.required<Project>();

  protected readonly store = inject(ProjectUpdatesStore);
  private readonly trama = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);

  protected readonly chevron = LucideChevronRight;
  protected readonly bookIcon = LucideBookOpen;
  protected readonly dialogOpen = signal(false);
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  protected readonly slug = computed(() => this.trama.slug() ?? '');
  protected readonly canPost = computed(() => this.trama.allowed('manageProjects') && !this.trama.isGuest());

  private readonly milestones = computed(() => this.trama.milestonesByProject().get(this.project().id) ?? []);
  private readonly issues = computed(() => this.trama.issuesByProject().get(this.project().id) ?? []);
  private readonly points = computed(() => usesPoints(this.issues(), this.trama.estimateScale()));
  /** The first milestone that is not complete yet. */
  private readonly currentId = computed(() => this.info.nextByProject().get(this.project().id)?.ms.id ?? null);

  private readonly healthName = (health: string): string =>
    resolveStatusEntry(this.trama.settings().statuses.projectHealth, health)?.name ?? health;

  private readonly ctx = computed<UpdatesContext>(() => ({
    project: this.project(),
    milestones: this.milestones(),
    issues: this.issues(),
    events: this.trama.events(),
    artifactById: this.trama.artifactById(),
    updates: this.store.updates(),
    points: this.points(),
    currentMilestoneId: this.currentId(),
    actorName: (actor) => this.trama.actorName(actor),
    statusName: (status) =>
      resolveStatusEntry(this.trama.settings().statuses.issue, status)?.name ?? status.replaceAll('_', ' '),
    isDoneStatus: (status) => statusTypeOf(this.trama.settings().statuses.issue, status) === 'done',
    healthName: this.healthName,
  }));

  private readonly rows = computed(() => deriveKeyEvents(this.ctx()));

  // ───────── summary ─────────

  protected readonly latest = computed(() => this.store.updates()[0] ?? null);
  protected readonly headline = computed(() => firstParagraph(this.latest()?.body ?? ''));

  protected authorName(u: ProjectUpdate): string {
    return this.trama.actorName(u.author);
  }
  protected postedOn(u: ProjectUpdate): string {
    return shortDate(u.createdAt);
  }

  // ───────── milestones ─────────

  private readonly windows = computed(() => milestoneWindows(this.project(), this.milestones()));

  /** Key events of the current milestone, or of the whole project when it has none. */
  protected readonly section = computed<Section | null>(() => {
    const p = this.project();
    const rows = this.rows();
    const stats = this.info.stats();
    const states = this.info.states();
    const id = this.currentId();
    const ms = id ? this.milestones().find((m) => m.id === id) : undefined;
    if (ms) {
      const w = this.windows().find((x) => x.milestone.id === ms.id);
      const s = stats.get(ms.id);
      const target = ms.targetDate ? shortDate(ms.targetDate).toUpperCase() : '—';
      return {
        id: ms.id,
        title: ms.name,
        meta: `MILESTONE · ${w ? shortDay(w.startDay).toUpperCase() : '—'} → ${target} · ${STATE_LABEL[states.get(ms.id) ?? 'idle']}`,
        done: s?.doneIssues ?? 0,
        total: s?.issues ?? 0,
        events: rows.filter((r) => r.milestoneId === ms.id),
      };
    }
    if (this.milestones().length) return null;
    const t = totalsOf(this.issues(), false);
    const start = shortDay(dayOf(p.startDate ?? p.createdAt)).toUpperCase();
    return {
      id: p.id,
      title: 'Key events',
      meta: `PROJECT · SINCE ${start}${p.targetDate ? ` → ${shortDate(p.targetDate).toUpperCase()}` : ''}`,
      done: t.doneIssues,
      total: t.issues,
      events: rows,
    };
  });

  /** Complete milestones, the latest first. */
  protected readonly past = computed<PastSection[]>(() => {
    const stats = this.info.stats();
    const rows = this.rows();
    const byMs = this.trama.issuesByMilestone();
    const current = this.currentId();
    return this.milestones()
      .filter((m) => m.id !== current && stats.get(m.id)?.complete)
      .reverse()
      .map((m) => {
        const issues = byMs.get(m.id) ?? [];
        const closed = closedDayOf(issues, m);
        const events = rows.filter((r) => r.milestoneId === m.id);
        const n = stats.get(m.id)?.issues ?? 0;
        return {
          id: m.id,
          title: m.name,
          meta: `MILESTONE · CLOSED${closed === null ? '' : ` ${shortDay(closed).toUpperCase()}`} · ${n} ${n === 1 ? 'TASK' : 'TASKS'}`,
          recap: recapOf(
            m,
            issues,
            events.flatMap((e) => (e.update ? [e.update] : [])),
          ),
          events,
        };
      });
  });

  protected isOpen(id: string): boolean {
    return this.opened().has(id);
  }
  protected toggle(id: string): void {
    this.opened.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // ───────── rail ─────────

  /** The rest of the latest update; else where the current milestone stands, from the tasks. */
  protected readonly standing = computed(() => {
    const u = this.latest();
    const rest = u ? restOfBody(u.body) : '';
    if (rest) return rest;
    const s = this.section();
    if (!s || !s.total) return u ? 'No tasks to count yet.' : 'Nothing to report yet.';
    const left = s.total - s.done;
    const ms = this.currentId() ? this.milestones().find((m) => m.id === this.currentId()) : undefined;
    const target = ms?.targetDate ? `, due ${shortDate(ms.targetDate)}` : '';
    return `${s.done} of ${s.total} ${s.total === 1 ? 'task is' : 'tasks are'} done in ${s.title}${target}, and ${left} ${left === 1 ? 'remains' : 'remain'}.`;
  });
  protected readonly standingNote = computed(() => {
    const u = this.latest();
    if (!u) return 'No update posted yet';
    const when = ago(u.createdAt);
    return `Updated ${when === 'now' ? 'just now' : `${when} ago`} · by ${this.authorName(u)}`;
  });

  protected readonly cast = computed(() => {
    const list = castOf(this.ctx(), this.project().leadId);
    return list.slice(0, CAST_CAP).map((c) => {
      const lead = c.actor.type === 'user' && c.actor.id === this.project().leadId;
      const bits: string[] = [];
      if (lead) bits.push('lead');
      if (c.events) bits.push(`${c.events} ${c.events === 1 ? 'event' : 'events'}`);
      if (c.actor.type === 'agent' && c.prs) bits.push(`${c.prs} ${c.prs === 1 ? 'PR' : 'PRs'}`);
      return {
        key: `${c.actor.type}:${c.actor.id ?? ''}`,
        actor: c.actor as ActorRef,
        name: this.trama.actorName(c.actor),
        note: bits.join(' · '),
      };
    });
  });

  /** The milestone after the current one. */
  protected readonly next = computed(() => {
    const list = this.milestones();
    const i = list.findIndex((m) => m.id === this.currentId());
    const ms = i >= 0 ? list[i + 1] : undefined;
    if (!ms) return null;
    const starts = list[i].targetDate ? `starts ${shortDate(list[i].targetDate!)}` : '';
    const n = (this.trama.issuesByMilestone().get(ms.id) ?? []).length;
    const count = `${n} ${n === 1 ? 'task' : 'tasks'}`;
    return { name: ms.name, meta: starts ? `${starts} · ${count}` : count, description: ms.description };
  });

  // ───────── actions ─────────

  constructor() {
    // What is there when the tab closes (or the project changes) no longer counts as new.
    effect((onCleanup) => {
      const id = this.project().id;
      onCleanup(() => this.store.markSeen(id));
    });
  }

  protected post(): void {
    this.dialogOpen.set(true);
  }

  protected exportChangelog(): void {
    const p = this.project();
    const markdown = changelogMarkdown({
      project: p,
      updates: this.store.updates(),
      milestones: this.milestones(),
      issues: this.issues(),
      authorName: (actor) => this.trama.actorName(actor),
      healthName: this.healthName,
      now: new Date(),
    });
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}-changelog.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url));
  }
}
