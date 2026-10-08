import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideActivity,
  LucideBot,
  LucideCircleCheck,
  LucideCircleHelp,
  LucideCircleX,
  LucideDynamicIcon,
  LucideFlag,
  LucideFolderGit2,
  LucideGitPullRequest,
  LucideInbox,
  LucideLink2,
  LucideListChecks,
  LucideMessageSquare,
  LucideRocket,
  LucideScale,
  LucideSquarePen,
  LucideTrash2,
  LucideUsers,
  type LucideIcon,
} from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ARTIFACT_KIND_META,
  ISSUE_STATUS_META,
  NablaStore,
  type DomainEvent,
  type IssueStatus,
  type WorkstreamStatus,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EntityChip, type EntityChipType } from '../../shared/entity-chip';
import { FullDatePipe } from '../../shared/pipes';
import { StatusIcon, statusLabel, type AnyStatus, type StatusEntity } from '../../shared/status';
import { AgoPipe } from './ago';

/** Coarse event family, used by the Activity page filters. */
export type EventCategory = 'workstream' | 'issue' | 'decision' | 'artifact' | 'comment' | 'input' | 'other';

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  workstream: 'Workstreams',
  issue: 'Issues',
  decision: 'Decisions',
  artifact: 'Artifacts',
  comment: 'Comments',
  input: 'Questions',
  other: 'Other',
};

export function eventCategory(e: DomainEvent): EventCategory {
  const prefix = e.type.split('.')[0];
  switch (prefix) {
    case 'workstream':
    case 'criterion':
    case 'dependency':
      return 'workstream';
    case 'issue':
      return 'issue';
    case 'decision':
      return 'decision';
    case 'artifact':
    case 'review':
      return 'artifact';
    case 'comment':
      return 'comment';
    case 'input':
      return 'input';
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
  /** Past-tense verb phrase, e.g. "answered", "attached a pull request". */
  verb: string;
  /** Main subject, rendered as an entity chip (status glyph · key · title). */
  subject?: EntityRef;
  /** Text subject when there is no entity to link (artifact title, question…). */
  text?: string;
  /** Link for a text subject. */
  link?: readonly unknown[];
  query?: Record<string, string>;
  /** Connector + secondary entity, e.g. "to" AUTH-12. */
  joiner?: string;
  target?: EntityRef;
  /** Status transition, rendered as glyph → glyph. */
  transition?: { from?: AnyStatus; to: AnyStatus; entity: StatusEntity };
  /** Secondary line (comment excerpt, answer…). */
  detail?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function humanize(type: string): string {
  return type.replace(/[._]/g, ' ');
}

function fieldsText(d: Record<string, unknown>): string | undefined {
  const f = strs(d['fields']);
  if (!f.length) return undefined;
  return f.map((x) => x.replace(/Id(s)?$/, '$1').replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ');
}

/** Turn a DomainEvent into a short, human-readable description (actor is rendered separately). */
export function describeEvent(e: DomainEvent, store: NablaStore, slug: string): EventView {
  const d = e.data ?? {};
  const ws = e.workstreamId ? store.workstreamById().get(e.workstreamId) : undefined;
  const wsRef: EntityRef | undefined = ws
    ? { type: 'workstream', ref: ws.id }
    : str(d['key']) && e.subject.type === 'workstream'
      ? { type: 'workstream', ref: str(d['key'])! }
      : undefined;
  const subjectWs: EntityRef | undefined =
    e.subject.type === 'workstream' ? { type: 'workstream', ref: store.workstreamById().has(e.subject.id) ? e.subject.id : (str(d['key']) ?? e.subject.id) } : wsRef;
  const issueRef = (): EntityRef => ({
    type: 'issue',
    ref: store.issueById().has(e.subject.id) ? e.subject.id : (str(d['key']) ?? e.subject.id),
  });
  const decisionRef = (): EntityRef => ({
    type: 'decision',
    ref: store.decisionById().has(e.subject.id) ? e.subject.id : (str(d['key']) ?? e.subject.id),
  });

  switch (e.type) {
    case 'workstream.created':
      return { icon: LucideRocket, verb: 'created workstream', subject: subjectWs, text: subjectWs ? undefined : str(d['title']) };
    case 'workstream.updated':
      return { icon: LucideSquarePen, verb: 'updated', subject: subjectWs, detail: fieldsText(d) };
    case 'workstream.deleted':
      return { icon: LucideTrash2, verb: 'deleted workstream', text: str(d['key']) ?? str(d['title']) };
    case 'workstream.status_changed': {
      const to = str(d['to']) as WorkstreamStatus | undefined;
      const from = str(d['from']) as WorkstreamStatus | undefined;
      return {
        icon: LucideActivity,
        verb: to ? `moved to ${statusLabel(to).toLowerCase()}` : 'changed status of',
        subject: subjectWs,
        transition: to ? { from, to, entity: 'workstream' } : undefined,
      };
    }
    case 'criterion.updated':
      return {
        icon: LucideListChecks,
        verb: d['state'] === 'met' ? 'met a criterion in' : 'updated a criterion in',
        subject: wsRef,
        detail: str(d['text']),
      };
    case 'input.requested':
      return { icon: LucideCircleHelp, verb: 'asked in', subject: wsRef, detail: str(d['question']) };
    case 'input.answered':
      return {
        icon: LucideCircleCheck,
        verb: 'answered a question in',
        subject: wsRef,
        detail: [str(d['question']), str(d['answer'])].filter(Boolean).join(' → ') || undefined,
      };
    case 'input.dismissed':
      return { icon: LucideCircleX, verb: 'dismissed a question in', subject: wsRef, detail: str(d['question']) };
    case 'artifact.attached': {
      const kind = str(d['kind']) as keyof typeof ARTIFACT_KIND_META | undefined;
      return {
        icon: LucideGitPullRequest,
        verb: `linked ${kind ? (ARTIFACT_KIND_META[kind]?.label.toLowerCase() ?? 'an artifact') : 'an artifact'}`,
        text: [str(d['externalId']), str(d['title'])].filter(Boolean).join(' ') || undefined,
        link: ws ? ['/', slug, 'workstreams', ws.key] : undefined,
        query: ws ? { tab: 'artifacts' } : undefined,
        joiner: wsRef ? 'to' : undefined,
        target: wsRef,
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
        link: ws ? ['/', slug, 'workstreams', ws.key] : undefined,
        query: ws ? { tab: 'artifacts' } : undefined,
        joiner: wsRef ? 'in' : undefined,
        target: wsRef,
        detail: bits.join(', ') || undefined,
      };
    }
    case 'artifact.deleted':
      return { icon: LucideTrash2, verb: 'removed', text: str(d['title']) ?? 'an artifact', joiner: wsRef ? 'from' : undefined, target: wsRef };
    case 'review.requested':
      return {
        icon: LucideGitPullRequest,
        verb: 'requested review on',
        text: [str(d['externalId']), str(d['title'])].filter(Boolean).join(' ') || 'a pull request',
        link: ws ? ['/', slug, 'workstreams', ws.key] : undefined,
        query: ws ? { tab: 'artifacts' } : undefined,
        joiner: wsRef ? 'in' : undefined,
        target: wsRef,
      };
    case 'decision.proposed':
    case 'decision.accepted':
    case 'decision.rejected':
    case 'decision.superseded':
    case 'decision.updated': {
      const verb = e.type.split('.')[1];
      return {
        icon: LucideScale,
        verb: verb === 'updated' ? 'updated decision' : `${verb} decision`,
        subject: decisionRef(),
        joiner: wsRef && verb === 'proposed' ? 'in' : undefined,
        target: verb === 'proposed' ? wsRef : undefined,
        detail: verb === 'updated' ? fieldsText(d) : undefined,
      };
    }
    case 'issue.created':
      return { icon: LucideInbox, verb: 'reported', subject: issueRef() };
    case 'issue.updated':
      return { icon: LucideSquarePen, verb: 'updated', subject: issueRef(), detail: fieldsText(d) };
    case 'issue.deleted':
      return { icon: LucideTrash2, verb: 'deleted issue', text: str(d['key']) };
    case 'issue.status_changed': {
      const to = str(d['to']) as IssueStatus | undefined;
      const from = str(d['from']) as IssueStatus | undefined;
      return {
        icon: LucideFlag,
        verb: to ? `moved to ${(ISSUE_STATUS_META[to]?.label ?? to).toLowerCase()}` : 'changed status of',
        subject: issueRef(),
        transition: to ? { from, to, entity: 'issue' } : undefined,
      };
    }
    case 'issue.linked': {
      const ids = strs(d['workstreamIds']);
      const created = str(d['createdWorkstreamId']);
      const targetId = created ?? ids[ids.length - 1];
      return {
        icon: LucideLink2,
        verb: 'added',
        subject: issueRef(),
        joiner: targetId ? 'to' : undefined,
        target: targetId ? { type: 'workstream', ref: targetId } : undefined,
        detail: ids.length > 1 ? `Contributes to ${ids.length} workstreams` : undefined,
      };
    }
    case 'dependency.added':
    case 'dependency.removed':
      return { icon: LucideLink2, verb: e.type.endsWith('added') ? 'added a dependency to' : 'removed a dependency from', subject: wsRef };
    case 'comment.created': {
      const target: EntityRef | undefined =
        e.subject.type === 'issue'
          ? { type: 'issue', ref: e.subject.id }
          : e.subject.type === 'decision'
            ? { type: 'decision', ref: e.subject.id }
            : wsRef;
      return { icon: LucideMessageSquare, verb: 'commented on', subject: target, detail: str(d['excerpt']) };
    }
    case 'team.created':
    case 'team.updated':
    case 'team.deleted':
      return {
        icon: LucideUsers,
        verb: `${e.type.split('.')[1]} team`,
        text: store.getTeam(e.subject.id)?.name ?? str(d['key']),
        link: e.type !== 'team.deleted' && str(d['key']) ? ['/', slug, 'teams', str(d['key'])] : undefined,
      };
    case 'repository.created':
    case 'repository.updated':
    case 'repository.deleted':
      return {
        icon: LucideFolderGit2,
        verb: `${e.type.split('.')[1]} project`,
        text: str(d['fullName']) ?? store.getRepository(e.subject.id)?.fullName,
        link: e.type !== 'repository.deleted' ? ['/', slug, 'projects', e.subject.id] : undefined,
      };
    default:
      return { icon: LucideActivity, verb: humanize(e.type), subject: wsRef };
  }
}

/**
 * One activity line: avatar · actor · verb · entity chip (· "to" chip) · time. Agents are tagged.
 *   <app-event-line [event]="e" [slug]="slug" />
 */
@Component({
  selector: 'app-event-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmTooltip, ActorAvatar, EntityChip, StatusIcon, AgoPipe, FullDatePipe],
  host: { class: 'flex items-start gap-2.5 py-1.5' },
  template: `
    @let ev = v();
    <app-actor-avatar class="mt-[3px]" [actor]="event().actor" [size]="18" />
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-6">
        <span class="font-medium">{{ actorName() }}</span>
        @if (isAgent()) {
          <span class="text-muted-foreground border-border-strong inline-flex h-4 items-center gap-0.5 rounded border px-1 text-[10px] leading-none">
            <svg [lucideIcon]="bot" [size]="9" [strokeWidth]="2"></svg>agent
          </span>
        }
        <span class="text-muted-foreground">{{ ev.verb }}</span>
        @if (ev.subject; as s) {
          <app-entity-chip [type]="s.type" [ref]="s.ref" [compact]="compact()" />
        }
        @if (ev.text) {
          @if (ev.link) {
            <a [routerLink]="ev.link" [queryParams]="ev.query" class="min-w-0 truncate hover:underline">{{ ev.text }}</a>
          } @else {
            <span class="min-w-0 truncate">{{ ev.text }}</span>
          }
        }
        @if (ev.target; as t) {
          <span class="text-muted-foreground">{{ ev.joiner }}</span>
          <app-entity-chip [type]="t.type" [ref]="t.ref" [compact]="compact()" />
        }
        @if (ev.transition; as tr) {
          <span class="text-muted-foreground inline-flex items-center gap-1 text-xs" [attr.aria-label]="'from ' + (tr.from ?? '?') + ' to ' + tr.to">
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
  private readonly store = inject(NablaStore);
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
