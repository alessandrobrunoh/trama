import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmHoverCardImports } from '@spartan-ng/helm/hover-card';
import type { Issue } from '../core/contracts/domain';
import { TramaStore } from '../core/stores/trama.store';
import { ActorAvatar, ActorLabel } from './actor-avatar';
import { IssueKindLabel } from './issue';
import type { TextLinker } from './markdown';
import { PriorityIcon } from './priority-icon';
import { StatusIcon, StatusLabel, type AnyStatus } from './status';

/** A record the assistant (or any text) mentioned, resolved against the loaded workspace. */
export type ResolvedRef = {
  type: 'issue';
  key: string;
  title: string;
  link: string[];
  issue: Issue;
};

const KEY_PATTERN = '\\b[A-Z][A-Z0-9]{1,7}-\\d+\\b';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds mentions of workspace records in plain text: issue keys (`CORA-142`) and people.
 * Only mentions that resolve to a loaded record become interactive; everything else stays text.
 */
@Injectable({ providedIn: 'root' })
export class EntityRefs {
  private readonly store = inject(TramaStore);

  resolve(token: string): ResolvedRef | null {
    const slug = this.store.slug() ?? '';
    const issue = this.store.getIssue(token);
    if (issue)
      return {
        type: 'issue',
        key: issue.key,
        title: issue.title,
        link: ['/', slug, 'tasks', issue.key],
        issue,
      };
    return null;
  }

  /** Markdown text → text, `ref` and `mention` nodes. Rebuilt when members or agents change. */
  readonly linker = computed<TextLinker>(() => {
    const names: string[] = [];
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
    ActorLabel,
    IssueKindLabel,
    PriorityIcon,
    StatusLabel,
  ],
  host: { class: 'flex flex-col gap-2' },
  template: `
    @if (ref(); as r) {
      <div class="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
        <app-issue-kind [kind]="r.issue.kind" [size]="13" />
        {{ r.key }}
      </div>
      <div class="text-[13px] leading-snug font-medium">{{ r.title }}</div>
      <div class="pt-2 text-xs">
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
              @if (r.issue.assigneeId) {
                <app-actor [actor]="{ type: 'user', id: r.issue.assigneeId }" [size]="16" />
              } @else {
                <span>Unassigned</span>
              }
            </div>
          }
        }
      </div>
    }
  `,
})
export class EntityPreview {
  readonly ref = input.required<ResolvedRef>();
}

function statusOf(
  r: ResolvedRef,
): { status: AnyStatus; entity: 'issue' | 'other' } | null {
  switch (r.type) {
    case 'issue':
      return { status: r.issue.status, entity: 'issue' };
    default:
      return null;
  }
}

/** Inline chip for a mentioned record, with a hover card; click opens it. */
@Component({
  selector: 'app-entity-ref',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmHoverCardImports, StatusIcon, EntityPreview],
  host: { class: 'inline' },
  template: `
    @if (resolved(); as r) {
      <hlm-hover-card>
        <a
          hlmHoverCardTrigger
          [routerLink]="r.link"
          class="bg-foreground/[0.06] hover:bg-accent mx-px inline-flex h-[1.4em] max-w-full items-center gap-1 rounded-md px-1.5 align-baseline font-mono text-[0.85em] whitespace-nowrap no-underline transition-colors"
        >
          @if (visual(); as v) {
            <app-status-icon [status]="v.status" [entity]="v.entity" [size]="12" />
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
          }
          <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ r.key }}</span>
          @if (visual(); as v) {
            <app-status-icon [status]="v.status" [entity]="v.entity" [size]="14" />
          }
          <span class="min-w-0 flex-1 truncate">{{ r.title }}</span>
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
  protected readonly resolved = computed(() => this.refs.resolve(this.token()));
  protected readonly visual = computed(() => {
    const r = this.resolved();
    return r ? statusOf(r) : null;
  });
  protected readonly assignee = computed(() => {
    const r = this.resolved();
    return r?.type === 'issue' ? r.issue.assigneeId : undefined;
  });
  protected readonly duplicatesTitle = computed(() => {
    const t = norm(this.trailText());
    const title = norm(this.resolved()?.title ?? '');
    return !t || (title.length > 0 && (title.includes(t) || t.includes(title)));
  });
}
