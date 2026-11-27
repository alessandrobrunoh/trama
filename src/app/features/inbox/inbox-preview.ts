// The Inbox preview column (v3 "03 · Inbox", right side): kicker · serif title · key, status, source and owner ·
// a "what changed" table · one line on what Trama will (not) do · the actions, each with its key.
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import {
  LucideCircleCheck,
  LucideCircleX,
  LucideDynamicIcon,
  LucideGitMerge,
  LucideGitPullRequest,
  LucideHistory,
  LucideLink,
  LucideLink2Off,
  LucideMessageCircle,
  LucideUser,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButton } from '@spartan-ng/helm/button';
import { TramaStore, resolveStatusEntry, type Artifact, type Issue } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { AgoPipe } from '../../shared/ago';
import { Kbd } from '../../shared/kbd';
import { V3Source, V3Status } from '../../shared/v3';
import { artifactRef, type InboxEntry } from './inbox-model';

interface ChangeRow {
  label: string;
  icon: LucideIcon;
  tone: string;
  value: string;
}

const OPEN_REQUEST = new Set(['draft', 'open']);
const isRequest = (a: Artifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';

/** "PR #418 · open · checks passing · approved" */
function requestLine(a: Artifact): string {
  const parts = [artifactRef(a, a.title), a.state];
  if (a.ci === 'passing') parts.push('checks passing');
  if (a.ci === 'failing') parts.push('checks failing');
  if (a.ci === 'pending') parts.push('checks running');
  if (a.review === 'approved') parts.push('approved');
  if (a.review === 'changes_requested') parts.push('changes requested');
  if (a.hasConflicts) parts.push('conflicts');
  return parts.join(' · ');
}

@Component({
  selector: 'app-inbox-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmButton, ActorAvatar, AgoPipe, Kbd, V3Source, V3Status],
  host: { class: 'flex min-w-0 flex-col gap-5 px-9 py-7' },
  template: `
    @let e = entry();
    @let i = issue();
    <header class="flex flex-col gap-2">
      <p class="text-delta font-mono text-[10.5px] leading-[14px] uppercase">
        {{ e.kicker }} · {{ e.at | ago }} ago
      </p>
      <h2 class="font-title text-foreground text-[30px] leading-[30px] tracking-[-0.3px]">
        {{ i?.title ?? e.sentence }}
      </h2>
      @if (i) {
        <div class="flex flex-wrap items-center gap-2.5">
          <span class="text-muted-foreground font-mono text-[11px] leading-[13px]">{{ i.key }}</span>
          <v3-status [status]="i.status" />
          <v3-source [issue]="i" />
          @if (i.assigneeId) {
            <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="22" />
          }
        </div>
      }
    </header>

    @if (rows().length) {
      <section class="border-border border" [attr.aria-label]="boxTitle()">
        <h3
          class="bg-card text-foreground border-border border-b px-4 py-2.5 font-mono text-[10.5px] leading-[13px] uppercase"
        >
          {{ boxTitle() }}
        </h3>
        @for (r of rows(); track r.label) {
          <div class="border-border flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <svg [lucideIcon]="r.icon" [size]="13" [strokeWidth]="1.75" class="shrink-0" [class]="r.tone"></svg>
            <span class="text-faint w-[70px] shrink-0 font-mono text-[10px] leading-[16px] uppercase">{{
              r.label
            }}</span>
            <span class="text-text-2 min-w-0 flex-1 text-[13px] leading-[16px] break-words">{{ r.value }}</span>
          </div>
        }
      </section>
    }

    <p class="text-muted-foreground max-w-[640px] text-[13px] leading-5">{{ note() }}</p>

    <div class="flex flex-wrap items-center gap-2">
      @if (moveToReview()) {
        <button hlmBtn type="button" (click)="toReview.emit()">Move to In review</button>
      }
      @switch (e.primary.type) {
        @case ('external') {
          <a
            hlmBtn
            [variant]="moveToReview() ? 'outline' : 'default'"
            [href]="externalUrl()"
            target="_blank"
            rel="noopener noreferrer"
            >{{ e.primary.label }} ↗</a
          >
        }
        @case ('open') {
          @if (!moveToReview()) {
            <button hlmBtn type="button" (click)="open.emit()">
              {{ i && e.primary.label === 'Open' ? 'Open task' : e.primary.label }} <app-kbd keys="enter" />
            </button>
          }
        }
      }
      @if (e.primary.type !== 'open' || moveToReview()) {
        <button hlmBtn variant="outline" type="button" (click)="open.emit()">
          {{ i ? 'Open task' : 'Open' }} <app-kbd keys="enter" />
        </button>
      }
      @if (i?.threadUrl) {
        <a hlmBtn variant="outline" [href]="i!.threadUrl" target="_blank" rel="noopener noreferrer"
          >Open in Delta ↗ <app-kbd keys="o"
        /></a>
      }
      @if (e.canMarkRead) {
        <button hlmBtn variant="outline" type="button" (click)="markRead.emit()">Mark read <app-kbd keys="e" /></button>
      }
      @if (e.canDismiss) {
        <!-- an item that waits on you is set aside with the same key and name as an update (v3 "Mark read E") -->
        <button hlmBtn variant="outline" type="button" (click)="dismiss.emit()">Mark read <app-kbd keys="e" /></button>
      }
    </div>
  `,
})
export class InboxPreview {
  readonly entry = input.required<InboxEntry>();

  readonly open = output<void>();
  readonly markRead = output<void>();
  readonly dismiss = output<void>();
  readonly toReview = output<void>();

  private readonly store = inject(TramaStore);

  protected readonly issue = computed<Issue | undefined>(() => this.entry().issue);

  private readonly artifact = computed(() => {
    const id = this.entry().attention?.artifactId;
    return id ? this.store.artifactById().get(id) : undefined;
  });

  private readonly openRequest = computed(() => {
    const i = this.issue();
    if (!i) return undefined;
    return (this.store.artifactsByIssue().get(i.id) ?? []).find((a) => isRequest(a) && OPEN_REQUEST.has(a.state));
  });

  /** A task still In progress with an open PR: offer the move (Trama never makes it on its own). */
  protected readonly moveToReview = computed(
    () => this.entry().source === 'task' && this.issue()?.status === 'in_progress' && !!this.openRequest(),
  );

  protected readonly externalUrl = computed(() => {
    const p = this.entry().primary;
    return p.type === 'external' ? p.url : null;
  });

  protected readonly boxTitle = computed(() => {
    const e = this.entry();
    if (e.source === 'task') return 'Where the task stands';
    if (e.source === 'update') return 'What changed';
    return 'What needs you';
  });

  protected readonly rows = computed<ChangeRow[]>(() => {
    const e = this.entry();
    const i = this.issue();
    const rows: ChangeRow[] = [];
    if (e.source === 'attention' && e.attention) {
      const a = this.artifact();
      const kind = e.attention.kind;
      rows.push({
        label: 'Event',
        icon: LucideHistory,
        tone: 'text-delta-line',
        value: e.attention.detail || e.sentence,
      });
      if (a) {
        rows.push({
          label: isRequest(a) ? (a.kind === 'merge_request' ? 'MR' : 'PR') : 'Artifact',
          icon: kind === 'conflict' ? LucideGitMerge : LucideGitPullRequest,
          tone: kind === 'review_requested' ? 'text-green' : 'text-red',
          value: isRequest(a) ? `${requestLine(a)} — ${a.title}` : a.title,
        });
        if (a.ci) {
          rows.push({
            label: 'Checks',
            icon: a.ci === 'failing' ? LucideCircleX : LucideCircleCheck,
            tone: a.ci === 'failing' ? 'text-red' : a.ci === 'passing' ? 'text-green' : 'text-yellow',
            value: a.ci,
          });
        }
      }
    }
    if (e.source === 'task' && i) {
      rows.push({ label: 'Activity', icon: LucideHistory, tone: 'text-delta-line', value: e.text ?? '' });
      const pr = this.openRequest();
      if (pr) rows.push({ label: 'PR', icon: LucideGitPullRequest, tone: 'text-green', value: requestLine(pr) });
    }
    if (e.source === 'update' && e.notification) {
      const n = e.notification;
      const who = this.store.actorName(n.actor);
      if (n.kind === 'comment' && n.body) {
        rows.push({ label: 'Comment', icon: LucideMessageCircle, tone: 'text-muted-foreground', value: n.body });
      }
      rows.push({
        label: n.kind === 'assigned' ? 'By' : 'From',
        icon: LucideUser,
        tone: 'text-muted-foreground',
        value: who,
      });
    }
    if (i && e.source !== 'attention') {
      rows.push(
        i.threadUrl
          ? { label: 'Thread', icon: LucideLink, tone: 'text-delta-line', value: i.threadUrl.replace(/^https?:\/\//, '') }
          : { label: 'Thread', icon: LucideLink2Off, tone: 'text-faint', value: 'No Delta thread linked' },
      );
    }
    return rows;
  });

  protected readonly note = computed(() => {
    const e = this.entry();
    const i = this.issue();
    const state = i ? (resolveStatusEntry(this.store.settings().statuses.issue, i.status)?.name ?? i.status) : '';
    switch (e.attention?.kind) {
      case 'review_requested':
        return 'Someone is waiting on your review. Review it at the provider — the task status stays as it is until a person moves it.';
      case 'ci_failed':
        return 'The checks are failing. Fix them, or dismiss this if the failure is known and accepted.';
      case 'conflict':
        return 'The branch conflicts with its base. Rebase or merge to clear it; Trama notices on the next sync.';
      case 'triage':
        return 'New in the backlog. Give it a priority and an owner, or move it out of the backlog.';
    }
    if (e.section === 'stale') {
      return `${e.text ?? 'Quiet for a while'}. Pick it back up, hand it over, or mark it done.`;
    }
    if (e.source === 'task') {
      return this.moveToReview()
        ? `Status stays ${state} — Trama never changes status on its own. The PR is open, so you may want to move this task to In review.`
        : `Status stays ${state} — Trama never changes status on its own. Mark it done when it is.`;
    }
    if (e.notification?.kind === 'assigned') return `${this.store.actorName(e.notification.actor)} assigned this task to you.`;
    if (e.notification?.kind === 'comment') return 'Reply in the task’s discussion.';
    return '';
  });
}
