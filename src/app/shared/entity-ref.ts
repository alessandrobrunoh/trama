import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideGitBranch } from '@lucide/angular';
import { HlmHoverCardImports } from '@spartan-ng/helm/hover-card';
import type { Decision, Issue, Repository, Workstream } from '../core/contracts/domain';
import { NablaStore } from '../core/stores/nabla.store';
import { ActorAvatar, ActorLabel } from './actor-avatar';
import { IssueKindLabel } from './issue';
import type { TextLinker } from './markdown';
import { FullDatePipe } from './pipes';
import { PriorityIcon } from './priority-icon';
import { StatusIcon, StatusLabel, type AnyStatus } from './status';

/** A record the assistant (or any text) mentioned, resolved against the loaded workspace. */
export type ResolvedRef =
  | { type: 'issue'; key: string; title: string; link: string[]; issue: Issue }
  | { type: 'workstream'; key: string; title: string; link: string[]; workstream: Workstream }
  | { type: 'decision'; key: string; title: string; link: string[]; decision: Decision }
  | { type: 'repository'; key: string; title: string; link: string[]; repository: Repository };

const KEY_PATTERN = '\\b[A-Z][A-Z0-9]{1,7}-\\d+\\b';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds mentions of workspace records in plain text: issue / workstream / decision keys
 * (`BUG-142`, `AUTH-42`, `ADR-21`) and repository names (`owner/name`). Only mentions that resolve to a
 * loaded record become interactive; everything else stays text.
 */
@Injectable({ providedIn: 'root' })
export class EntityRefs {
  private readonly store = inject(NablaStore);

  resolve(token: string): ResolvedRef | null {
    const slug = this.store.slug() ?? '';
    const issue = this.store.getIssue(token);
    if (issue)
      return {
        type: 'issue',
        key: issue.key,
        title: issue.title,
        link: ['/', slug, 'issues', issue.key],
        issue,
      };
    const workstream = this.store.getWorkstream(token);
    if (workstream)
      return {
        type: 'workstream',
        key: workstream.key,
        title: workstream.title,
        link: ['/', slug, 'workstreams', workstream.key],
        workstream,
      };
    const decision = this.store.getDecision(token);
    if (decision)
      return {
        type: 'decision',
        key: decision.key,
        title: decision.title,
        link: ['/', slug, 'decisions', decision.key],
        decision,
      };
    const repository = this.store.repositories().find((r) => r.fullName === token);
    if (repository)
      return {
        type: 'repository',
        key: repository.fullName,
        title: repository.fullName,
        link: ['/', slug, 'repositories', repository.id],
        repository,
      };
    return null;
  }

  /** Markdown text → text, `ref` and `mention` nodes. Rebuilt when repositories, members or agents change. */
  readonly linker = computed<TextLinker>(() => {
    const names = this.store
      .repositories()
      .map((r) => r.fullName)
      .filter((n) => n.length >= 3)
      .map(escapeRegExp);
    const people = [...this.store.users().map((u) => u.name), ...this.store.agents().map((a) => a.name)]
      .filter((n) => n.trim())
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);
    const parts = [`#?${KEY_PATTERN}`];
    if (names.length) parts.push(`(?<![\\w/.-])(?:${names.join('|')})(?![\\w/.-])`);
    if (people.length) parts.push(`(?<![\\w@])@(?:${people.join('|')})(?!\\w)`);
    const pattern = new RegExp(parts.join('|'), 'g');
    return (text) => {
      const out: ReturnType<TextLinker> = [];
      let last = 0;
      for (const m of text.matchAll(pattern)) {
        const mention = m[0].startsWith('@');
        const token = m[0].replace(/^#/, '');
        if (!mention && !this.resolve(token)) continue;
        if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
        out.push(mention ? { t: 'mention', v: m[0] } : { t: 'ref', v: token });
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
      return out;
    };
  });
}

/** Contents of the hover card: what the record is, at a glance. */
@Component({
  selector: 'app-entity-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActorAvatar,
    ActorLabel,
    FullDatePipe,
    IssueKindLabel,
    LucideDynamicIcon,
    PriorityIcon,
    StatusIcon,
    StatusLabel,
  ],
  host: { class: 'flex flex-col gap-2' },
  template: `
    @if (ref(); as r) {
      <div class="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
        @switch (r.type) {
          @case ('issue') {
            <app-issue-kind [kind]="r.issue.kind" [size]="13" />
          }
          @case ('workstream') {
            <app-status-icon [status]="r.workstream.status" entity="workstream" [size]="13" />
          }
          @case ('repository') {
            <svg [lucideIcon]="gitIcon" [size]="13"></svg>
          }
        }
        {{ r.key }}
      </div>
      @if (r.type !== 'repository') {
        <div class="text-[13px] leading-snug font-medium">{{ r.title }}</div>
      }
      <div class="border-t pt-2 text-xs">
        @switch (r.type) {
          @case ('issue') {
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <app-status-label [status]="r.issue.status" entity="issue" />
              <app-priority-icon [priority]="r.issue.priority" showLabel />
              @if (r.issue.estimate) {
                <span class="text-muted-foreground">{{ r.issue.estimate }} pts</span>
              }
            </div>
            <div class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              @if (team(); as t) {
                <span>{{ t }}</span>
              }
              @if (r.issue.assigneeId) {
                <app-actor [actor]="{ type: 'user', id: r.issue.assigneeId }" [size]="16" />
              } @else {
                <span>Unassigned</span>
              }
            </div>
          }
          @case ('workstream') {
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <app-status-label [status]="r.workstream.status" entity="workstream" />
              <app-priority-icon [priority]="r.workstream.priority" showLabel />
            </div>
            <div class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              @if (team(); as t) {
                <span>{{ t }}</span>
              }
              @if (r.workstream.accountableUserId) {
                <app-actor
                  [actor]="{ type: 'user', id: r.workstream.accountableUserId }"
                  [size]="16"
                />
              }
              @if (r.workstream.targetDate) {
                <span>Due {{ r.workstream.targetDate | fullDate }}</span>
              }
            </div>
            @if (r.workstream.objective) {
              <p class="text-muted-foreground mt-1.5 line-clamp-3 leading-snug">
                {{ r.workstream.objective }}
              </p>
            }
          }
          @case ('decision') {
            <app-status-label [status]="r.decision.status" entity="other" />
            @if (r.decision.statement) {
              <p class="text-muted-foreground mt-1.5 line-clamp-3 leading-snug">
                {{ r.decision.statement }}
              </p>
            }
          }
          @case ('repository') {
            <div class="text-muted-foreground">
              {{ r.repository.provider }} · default branch
              <span class="text-foreground font-mono">{{
                r.repository.defaultBranch ?? 'main'
              }}</span>
            </div>
          }
        }
      </div>
    }
  `,
})
export class EntityPreview {
  private readonly store = inject(NablaStore);
  readonly ref = input.required<ResolvedRef>();
  protected readonly gitIcon = LucideGitBranch;
  protected readonly team = computed(() => {
    const r = this.ref();
    const id =
      r.type === 'issue'
        ? r.issue.teamId
        : r.type === 'workstream'
          ? r.workstream.ownerTeamId
          : undefined;
    return id ? this.store.getTeam(id)?.name : undefined;
  });
}

function statusOf(
  r: ResolvedRef,
): { status: AnyStatus; entity: 'issue' | 'workstream' | 'other' } | null {
  switch (r.type) {
    case 'issue':
      return { status: r.issue.status, entity: 'issue' };
    case 'workstream':
      return { status: r.workstream.status as AnyStatus, entity: 'workstream' };
    case 'decision':
      return { status: r.decision.status, entity: 'other' };
    default:
      return null;
  }
}

/** Inline chip for a mentioned record, with a hover card; click opens it. */
@Component({
  selector: 'app-entity-ref',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmHoverCardImports, StatusIcon, LucideDynamicIcon, EntityPreview],
  host: { class: 'inline' },
  template: `
    @if (resolved(); as r) {
      <hlm-hover-card>
        <a
          hlmHoverCardTrigger
          [routerLink]="r.link"
          class="border-border-strong hover:bg-accent hover:border-foreground/20 mx-px inline-flex h-[1.4em] max-w-full items-center gap-1 rounded-md border px-1.5 align-baseline font-mono text-[0.85em] whitespace-nowrap no-underline transition-colors"
        >
          @if (visual(); as v) {
            <app-status-icon [status]="v.status" [entity]="v.entity" [size]="12" />
          } @else {
            <svg [lucideIcon]="gitIcon" [size]="12"></svg>
          }
          {{ r.key }}
        </a>
        <hlm-hover-card-content *hlmHoverCardPortal class="w-72">
          <app-entity-preview [ref]="r" />
        </hlm-hover-card-content>
      </hlm-hover-card>
    } @else {
      {{ token() }}
    }
  `,
})
export class EntityRefChip {
  private readonly refs = inject(EntityRefs);
  readonly token = input.required<string>();
  protected readonly gitIcon = LucideGitBranch;
  protected readonly resolved = computed(() => this.refs.resolve(this.token()));
  protected readonly visual = computed(() => {
    const r = this.resolved();
    return r ? statusOf(r) : null;
  });
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** One row of a record list inside a reply: priority · key · status · title … assignee, with a hover card. */
@Component({
  selector: 'app-entity-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmHoverCardImports,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    LucideDynamicIcon,
    EntityPreview,
  ],
  host: { class: 'block' },
  template: `
    @if (resolved(); as r) {
      <hlm-hover-card>
        <a
          hlmHoverCardTrigger
          [routerLink]="r.link"
          class="hover:bg-accent/60 flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-[13px] no-underline transition-colors"
        >
          @if (r.type === 'issue') {
            <app-priority-icon [priority]="r.issue.priority" />
          } @else if (r.type === 'workstream') {
            <app-priority-icon [priority]="r.workstream.priority" />
          }
          <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ r.key }}</span>
          @if (visual(); as v) {
            <app-status-icon [status]="v.status" [entity]="v.entity" [size]="14" />
          } @else {
            <svg [lucideIcon]="gitIcon" [size]="14" class="text-muted-foreground shrink-0"></svg>
          }
          <span class="min-w-0 flex-1 truncate">{{ r.type === 'repository' ? '' : r.title }}</span>
          @if (assignee(); as a) {
            <app-actor-avatar [actor]="{ type: 'user', id: a }" [size]="18" />
          }
        </a>
        <hlm-hover-card-content *hlmHoverCardPortal class="w-72">
          <app-entity-preview [ref]="r" />
        </hlm-hover-card-content>
      </hlm-hover-card>
      @if (!duplicatesTitle()) {
        <div
          class="text-muted-foreground -mt-1 px-3 pb-1.5 pl-[3.25rem] text-xs leading-snug empty:hidden"
        >
          <ng-content />
        </div>
      }
    } @else {
      <div class="px-3 py-1.5 text-[13px]"><ng-content /></div>
    }
  `,
})
export class EntityRow {
  private readonly refs = inject(EntityRefs);
  readonly token = input.required<string>();
  /** Plain text of the commentary after the key, used to hide it when it only repeats the title. */
  readonly trailText = input('');
  protected readonly gitIcon = LucideGitBranch;
  protected readonly resolved = computed(() => this.refs.resolve(this.token()));
  protected readonly visual = computed(() => {
    const r = this.resolved();
    return r ? statusOf(r) : null;
  });
  protected readonly assignee = computed(() => {
    const r = this.resolved();
    return r?.type === 'issue'
      ? r.issue.assigneeId
      : r?.type === 'workstream'
        ? r.workstream.accountableUserId
        : undefined;
  });
  protected readonly duplicatesTitle = computed(() => {
    const t = norm(this.trailText());
    const title = norm(this.resolved()?.title ?? '');
    return !t || (title.length > 0 && (title.includes(t) || t.includes(title)));
  });
}
