import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideActivity,
  LucideBookOpen,
  LucideBot,
  LucideDynamicIcon,
  LucideFlag,
  LucideBox,
  LucideDiamond,
  LucideGitPullRequest,
  LucideInbox,
  LucideLink2,
  LucideListChecks,
  LucideMessageSquare,
  LucideRocket,
  LucideSquarePen,
  LucideTrash2,
  type LucideIcon,
} from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ARTIFACT_KIND_META,
  ISSUE_STATUS_META,
  TramaStore,
  type DomainEvent,
  type IssueStatus,
} from '../core';
import { ActorAvatar } from './actor-avatar';
import { EntityChip, type EntityChipType } from './entity-chip';
import { FullDatePipe } from './pipes';
import { StatusIcon, type AnyStatus, type StatusEntity } from './status';
import { AgoPipe } from './ago';

/** Coarse event family, used by the Activity page filters. */
export type EventCategory = 'issue' | 'artifact' | 'comment' | 'other';

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  issue: 'Tasks',
  artifact: 'Artifacts',
  comment: 'Comments',
  other: 'Other',
};

export function eventCategory(e: DomainEvent): EventCategory {
  const prefix = e.type.split('.')[0];
  switch (prefix) {
    case 'issue':
      return 'issue';
    case 'artifact':
    case 'review':
      return 'artifact';
    case 'comment':
      return 'comment';
    default:
      return 'other';
  }
}

export interface EntityRef {
  type: EntityChipType;
  ref: string;
}

export interface EventView {
  icon: LucideIcon;
  /** Past-tense verb phrase, e.g. "moved to done", "attached a pull request". */
  verb: string;
  /** Main subject, rendered as an entity chip (status glyph · key · title). */
  subject?: EntityRef;
  /** Text subject when there is no entity to link (artifact title…). */
  text?: string;
  /** Link for a text subject. */
  link?: readonly unknown[];
  query?: Record<string, string>;
  /** Connector + secondary entity, e.g. "to" AUTH-12. */
  joiner?: string;
  target?: EntityRef;
  /** Status transition, rendered as glyph → glyph. */
  transition?: { from?: AnyStatus; to: AnyStatus; entity: StatusEntity };
  /** Secondary line (comment excerpt…). */
  detail?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function humanize(type: string): string {
  return type.replace(/[._]/g, ' ');
}

function fieldsText(d: Record<string, unknown>): string | undefined {
  const f = strs(d['fields']);
  if (!f.length) return undefined;
  return f
    .map((x) =>
      x
        .replace(/Id(s)?$/, '$1')
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase(),
    )
    .join(', ');
}

/** Turn a DomainEvent into a short, human-readable description (actor is rendered separately). */
export function describeEvent(e: DomainEvent, store: TramaStore, slug: string): EventView {
  const d = e.data ?? {};
  // Historical workstream events remain readable, but deliberately have no entity link.
  const legacyText = (): string | undefined =>
    str(d['title']) ??
    str(d['key']) ??
    (e.subject.type === 'workstream' ? e.subject.id : undefined);
  const issueRef = (): EntityRef => ({
    type: 'issue',
    ref: store.issueById().has(e.subject.id) ? e.subject.id : (str(d['key']) ?? e.subject.id),
  });

  switch (e.type) {
    case 'workstream.created':
      return { icon: LucideRocket, verb: 'created legacy workstream', text: legacyText() };
    case 'workstream.updated':
      return {
        icon: LucideSquarePen,
        verb: 'updated legacy workstream',
        text: legacyText(),
        detail: fieldsText(d),
      };
    case 'workstream.deleted':
      return { icon: LucideTrash2, verb: 'deleted legacy workstream', text: legacyText() };
    case 'workstream.status_changed': {
      return {
        icon: LucideActivity,
        verb: `changed legacy workstream status to ${str(d['to']) ?? 'unknown'}`,
        text: legacyText(),
      };
    }
    case 'criterion.updated':
      return {
        icon: LucideListChecks,
        verb: d['state'] === 'met' ? 'met a legacy criterion' : 'updated a legacy criterion',
        text: str(d['key']) ?? str(d['text']),
      };
    case 'artifact.attached': {
      const kind = str(d['kind']) as keyof typeof ARTIFACT_KIND_META | undefined;
      return {
        icon: LucideGitPullRequest,
        verb: `linked ${kind ? (ARTIFACT_KIND_META[kind]?.label.toLowerCase() ?? 'an artifact') : 'an artifact'}`,
        text: [str(d['externalId']), str(d['title'])].filter(Boolean).join(' ') || undefined,
      };
    }
    case 'artifact.updated': {
      const ch = (d['changes'] ?? {}) as Record<string, unknown[]>;
      const bits: string[] = [];
      for (const [k, v] of Object.entries(ch)) {
        const to = Array.isArray(v) ? v[1] : undefined;
        if (typeof to === 'string') bits.push(`${k} ${to.replace(/_/g, ' ')}`);
        else if (typeof to === 'boolean') bits.push(to ? k : `no ${k}`);
      }
      return {
        icon: LucideGitPullRequest,
        verb: 'updated',
        text: [str(d['externalId']), str(d['title'])].filter(Boolean).join(' ') || 'an artifact',
        detail: bits.join(', ') || undefined,
      };
    }
    case 'artifact.deleted':
      return { icon: LucideTrash2, verb: 'removed', text: str(d['title']) ?? 'an artifact' };
    case 'review.requested':
      return {
        icon: LucideGitPullRequest,
        verb: 'requested review on',
        text: [str(d['externalId']), str(d['title'])].filter(Boolean).join(' ') || 'a pull request',
      };
    case 'issue.created':
      return { icon: LucideInbox, verb: 'reported', subject: issueRef() };
    case 'issue.updated':
      return { icon: LucideSquarePen, verb: 'updated', subject: issueRef(), detail: fieldsText(d) };
    case 'issue.deleted':
      return { icon: LucideTrash2, verb: 'deleted task', text: str(d['key']) };
    case 'issue.status_changed': {
      const to = str(d['to']) as IssueStatus | undefined;
      const from = str(d['from']) as IssueStatus | undefined;
      return {
        icon: LucideFlag,
        verb: to
          ? `moved to ${(ISSUE_STATUS_META[to]?.label ?? to).toLowerCase()}`
          : 'changed status of',
        subject: issueRef(),
        transition: to ? { from, to, entity: 'issue' } : undefined,
      };
    }
    case 'issue.linked': {
      const ids = strs(d['workstreamIds']);
      return {
        icon: LucideLink2,
        verb: 'updated legacy task associations',
        subject: issueRef(),
        detail: ids.length
          ? `${ids.length} legacy workstream link${ids.length === 1 ? '' : 's'}`
          : 'This event predates Issue-only associations.',
      };
    }
    case 'dependency.added':
    case 'dependency.removed':
      return {
        icon: LucideLink2,
        verb: e.type.endsWith('added')
          ? 'added a legacy dependency'
          : 'removed a legacy dependency',
        text: legacyText(),
      };
    case 'comment.created': {
      const target: EntityRef | undefined =
        e.subject.type === 'issue' ? { type: 'issue', ref: e.subject.id } : undefined;
      return {
        icon: LucideMessageSquare,
        verb: 'commented on',
        subject: target,
        text: e.subject.type === 'issue' ? undefined : (legacyText() ?? str(d['key'])),
        detail: str(d['excerpt']),
      };
    }
    case 'milestone.created':
    case 'milestone.updated':
    case 'milestone.deleted': {
      const projectId = str(d['projectId']);
      return {
        icon: LucideDiamond,
        verb: `${e.type.split('.')[1]} milestone`,
        text: str(d['name']) ?? store.getMilestone(e.subject.id)?.name,
        link:
          projectId && store.getProject(projectId) ? ['/', slug, 'projects', projectId] : undefined,
      };
    }
    case 'project.update_posted':
      return {
        icon: LucideBookOpen,
        verb: 'posted an update on',
        text: store.getProject(e.subject.id)?.name ?? str(d['name']),
        detail: str(d['excerpt']),
        link: store.getProject(e.subject.id) ? ['/', slug, 'projects', e.subject.id] : undefined,
        query: { tab: 'updates' },
      };
    case 'project.created':
    case 'project.updated':
    case 'project.status_changed':
    case 'project.deleted': {
      const verb = e.type === 'project.status_changed' ? 'changed status of' : e.type.split('.')[1];
      return {
        icon: LucideBox,
        verb: `${verb} project`,
        text: str(d['name']) ?? store.getProject(e.subject.id)?.name,
        detail:
          e.type === 'project.status_changed'
            ? `${str(d['from']) ?? ''} → ${str(d['to']) ?? ''}`.replaceAll('_', ' ')
            : undefined,
        link: e.type !== 'project.deleted' ? ['/', slug, 'projects', e.subject.id] : undefined,
      };
    }
    default:
      return { icon: LucideActivity, verb: humanize(e.type), text: str(d['key']) ?? str(d['title']) };
  }
}

/**
 * One activity line: avatar · actor · verb · entity chip (· "to" chip) · time. Agents are tagged.
 *   <app-event-line [event]="e" [slug]="slug" />
 */
@Component({
  selector: 'app-event-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmTooltip,
    ActorAvatar,
    EntityChip,
    StatusIcon,
    AgoPipe,
    FullDatePipe,
  ],
  host: { class: 'flex items-start gap-2.5 py-1.5' },
  template: `
    @let ev = v();
    <app-actor-avatar class="mt-[3px]" [actor]="event().actor" [size]="18" />
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-6">
        <span class="font-medium">{{ actorName() }}</span>
        @if (isAgent()) {
          <span
            class="text-muted-foreground bg-secondary inline-flex h-4 items-center gap-0.5 rounded px-1 text-[10px] leading-none"
          >
            <svg [lucideIcon]="bot" [size]="9" [strokeWidth]="2"></svg>agent
          </span>
        }
        <span class="text-muted-foreground">{{ ev.verb }}</span>
        @if (ev.subject; as s) {
          <app-entity-chip [type]="s.type" [ref]="s.ref" [compact]="compact()" />
        }
        @if (ev.text) {
          @if (ev.link) {
            <a
              [routerLink]="ev.link"
              [queryParams]="ev.query"
              class="min-w-0 truncate hover:underline"
              >{{ ev.text }}</a
            >
          } @else {
            <span class="min-w-0 truncate">{{ ev.text }}</span>
          }
        }
        @if (ev.target; as t) {
          <span class="text-muted-foreground">{{ ev.joiner }}</span>
          <app-entity-chip [type]="t.type" [ref]="t.ref" [compact]="compact()" />
        }
        @if (ev.transition; as tr) {
          <span
            class="text-muted-foreground inline-flex items-center gap-1 text-xs"
            [attr.aria-label]="'from ' + (tr.from ?? '?') + ' to ' + tr.to"
          >
            @if (tr.from) {
              <app-status-icon [status]="tr.from" [entity]="tr.entity" [size]="12" />
              <span aria-hidden="true">→</span>
            }
            <app-status-icon [status]="tr.to" [entity]="tr.entity" [size]="12" />
          </span>
        }
      </div>
      @if (ev.detail && !hideDetail()) {
        <p class="text-meta line-clamp-2 [overflow-wrap:anywhere]">{{ ev.detail }}</p>
      }
    </div>
    <span
      class="text-meta mt-[3px] shrink-0 tabular-nums"
      [hlmTooltip]="event().at | fullDate"
      position="left"
      >{{ event().at | ago }}</span
    >
  `,
})
export class EventLine {
  private readonly store = inject(TramaStore);
  readonly event = input.required<DomainEvent>();
  readonly slug = input.required<string>();
  /** Chips show the key only. */
  readonly compact = input(false, { transform: booleanAttribute });
  readonly hideDetail = input(false, { transform: booleanAttribute });

  protected readonly bot = LucideBot;
  protected readonly v = computed(() => describeEvent(this.event(), this.store, this.slug()));
  protected readonly actorName = computed(() => this.store.actorName(this.event().actor));
  protected readonly isAgent = computed(() => this.event().actor.type === 'agent');
}
