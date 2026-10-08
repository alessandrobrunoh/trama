import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideBot,
  LucideDynamicIcon,
  LucideGitPullRequest,
  LucideMessageSquare,
  LucideCircleHelp,
  LucideCircleCheck,
  LucideInbox,
  LucideScale,
  LucideFlag,
  LucideLink2,
  LucidePlay,
  LucideSquarePen,
  LucideActivity,
  LucideListChecks,
  LucideLayers,
  LucideRocket,
  type LucideIcon,
} from '@lucide/angular';
import {
  ARTIFACT_KIND_META,
  NablaStore,
  type DomainEvent,
  type WorkstreamStatus,
} from '../../core';
import { statusLabel } from '../../shared/status';
import { ActorAvatar } from '../../shared/actor-avatar';
import { KeyChip } from '../../shared/key-chip';
import { AgoPipe } from './ago';

export interface EventView {
  icon: LucideIcon;
  /** Past-tense verb phrase, e.g. "answered", "attached a pull request". */
  verb: string;
  /** Subject key (mono), e.g. AUTH-42. */
  key?: string;
  /** Subject text (title / question). */
  text?: string;
  /** Router commands for the subject. */
  link?: readonly unknown[];
  /** Secondary line (comment excerpt, progress note, answer…). */
  detail?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function humanize(type: string): string {
  return type.replace(/[._]/g, ' ');
}

/** Turn a DomainEvent into a short, human-readable description (actor is rendered separately). */
export function describeEvent(e: DomainEvent, store: NablaStore, slug: string): EventView {
  const d = e.data ?? {};
  const ws = e.workstreamId ? store.workstreamById().get(e.workstreamId) : undefined;
  const wsLink = ws ? ['/', slug, 'workstreams', ws.key] : undefined;
  const wsPart = { key: ws?.key, text: ws?.title, link: wsLink };

  switch (e.type) {
    case 'workstream.created':
      return {
        icon: LucideLayers,
        verb: 'created workstream',
        key: str(d['key']) ?? ws?.key,
        text: str(d['title']) ?? ws?.title,
        link: wsLink,
      };
    case 'workstream.updated':
      return { icon: LucideSquarePen, verb: 'updated', ...wsPart };
    case 'workstream.status_changed': {
      const to = str(d['to']) as WorkstreamStatus | undefined;
      const from = str(d['from']) as WorkstreamStatus | undefined;
      return {
        icon: LucideActivity,
        verb: to ? `moved to ${statusLabel(to).toLowerCase()}` : 'changed status of',
        key: str(d['key']) ?? ws?.key,
        text: ws?.title,
        link: wsLink,
        detail: from && to ? `${statusLabel(from)} → ${statusLabel(to)}` : undefined,
      };
    }
    case 'criterion.updated':
      return {
        icon: LucideListChecks,
        verb: d['state'] === 'met' ? 'met a criterion in' : 'updated a criterion in',
        ...wsPart,
        detail: str(d['text']),
      };
    case 'execution.created': {
      const prov = str(d['provider']);
      return {
        icon: LucidePlay,
        verb: 'started',
        text: str(d['title']),
        link: wsLink,
        detail: [ws?.key, prov && prov !== 'human' ? `via ${prov.replace('_', ' ')}` : undefined].filter(Boolean).join(' · ') || undefined,
      };
    }
    case 'execution.state_changed': {
      const to = str(d['to'])?.replace('_', ' ');
      return {
        icon: LucidePlay,
        verb: to ? `set ${to}:` : 'updated',
        text: str(d['title']),
        link: ['/', slug, 'executions', e.subject.id],
        detail: ws?.key,
      };
    }
    case 'execution.progress':
      return {
        icon: LucideActivity,
        verb: 'reported progress on',
        text: str(d['title']),
        link: ['/', slug, 'executions', e.subject.id],
        detail: str(d['note']),
      };
    case 'input.requested':
      return {
        icon: LucideCircleHelp,
        verb: 'asked',
        text: str(d['question']),
        link: wsLink,
        detail: ws ? `${ws.key} · needs an answer` : undefined,
      };
    case 'input.answered':
      return {
        icon: LucideCircleCheck,
        verb: 'answered',
        text: str(d['question']),
        link: wsLink,
        detail: str(d['answer']),
      };
    case 'artifact.attached': {
      const kind = str(d['kind']) as keyof typeof ARTIFACT_KIND_META | undefined;
      return {
        icon: LucideGitPullRequest,
        verb: `attached ${kind ? ARTIFACT_KIND_META[kind]?.label.toLowerCase() : 'an artifact'}`,
        text: str(d['title']),
        link: ws ? ['/', slug, 'workstreams', ws.key] : undefined,
        detail: ws?.key,
      };
    }
    case 'artifact.updated': {
      const ch = (d['changes'] ?? {}) as Record<string, unknown[]>;
      const bits: string[] = [];
      for (const [k, v] of Object.entries(ch)) {
        const to = Array.isArray(v) ? v[1] : undefined;
        if (typeof to === 'string') bits.push(`${k} ${to.replace('_', ' ')}`);
        else if (typeof to === 'boolean') bits.push(to ? k : `no ${k}`);
      }
      return {
        icon: LucideRocket,
        verb: 'updated',
        text: str(d['title']),
        link: wsLink,
        detail: [ws?.key, bits.join(', ')].filter(Boolean).join(' · ') || undefined,
      };
    }
    case 'review.requested':
      return {
        icon: LucideGitPullRequest,
        verb: 'requested review on',
        text: str(d['title']),
        link: wsLink,
        detail: [ws?.key, str(d['externalId'])].filter(Boolean).join(' · ') || undefined,
      };
    case 'decision.proposed':
    case 'decision.accepted':
    case 'decision.rejected':
    case 'decision.superseded': {
      const key = str(d['key']);
      return {
        icon: LucideScale,
        verb: `${e.type.split('.')[1]}`,
        key,
        text: str(d['title']),
        link: key ? ['/', slug, 'decisions', key] : undefined,
      };
    }
    case 'issue.created': {
      const key = str(d['key']);
      return {
        icon: LucideInbox,
        verb: 'opened',
        key,
        text: str(d['title']),
        link: key ? ['/', slug, 'issues', key] : undefined,
      };
    }
    case 'issue.status_changed':
    case 'issue.linked': {
      const key = str(d['key']);
      const to = str(d['to']);
      return {
        icon: LucideFlag,
        verb: e.type === 'issue.linked' ? 'linked' : `moved to ${to?.replace(/_/g, ' ') ?? 'a new status'}:`,
        key,
        text: key ? store.issueByKey().get(key)?.title : undefined,
        link: key ? ['/', slug, 'issues', key] : undefined,
      };
    }
    case 'dependency.added':
      return { icon: LucideLink2, verb: 'added a dependency in', ...wsPart };
    case 'comment.created': {
      const issue = e.subject.type === 'issue' ? store.issueById().get(e.subject.id) : undefined;
      return {
        icon: LucideMessageSquare,
        verb: 'commented on',
        key: issue?.key ?? ws?.key,
        text: issue?.title ?? ws?.title,
        link: issue ? ['/', slug, 'issues', issue.key] : wsLink,
        detail: str(d['excerpt']),
      };
    }
    default:
      return { icon: LucideActivity, verb: humanize(e.type), ...wsPart };
  }
}

/**
 * One activity line: actor + verb + subject link + relative time. Agents are visually distinct
 * (rounded avatar with pip, "agent" tag).
 */
@Component({
  selector: 'app-event-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, ActorAvatar, KeyChip, AgoPipe],
  host: { class: 'flex items-start gap-2.5 py-1.5' },
  template: `
    <app-actor-avatar class="mt-0.5" [actor]="event().actor" [size]="20" />
    <div class="min-w-0 flex-1">
      <p class="text-sm leading-snug [overflow-wrap:anywhere]">
        <span class="font-medium">{{ actorName() }}</span>
        @if (isAgent()) {
          <span
            class="text-muted-foreground border-border ms-1 inline-flex translate-y-[-1px] items-center gap-0.5 rounded border px-1 align-middle text-[10px] leading-4"
            ><svg [lucideIcon]="bot" [size]="9" [strokeWidth]="2"></svg>agent</span
          >
        }
        <span class="text-muted-foreground"> {{ v().verb }} </span>
        @if (v().link) {
          <a [routerLink]="v().link" class="hover:underline">
            @if (v().key) {
              <app-key-chip class="me-1 align-baseline" [value]="v().key!" />
            }
            <span>{{ v().text }}</span>
          </a>
        } @else {
          @if (v().key) {
            <app-key-chip class="me-1 align-baseline" [value]="v().key!" />
          }
          <span>{{ v().text }}</span>
        }
      </p>
      @if (v().detail) {
        <p class="text-meta line-clamp-1">{{ v().detail }}</p>
      }
    </div>
    <span class="text-meta mt-0.5 shrink-0 tabular-nums">{{ event().at | ago }}</span>
  `,
})
export class EventLine {
  private readonly store = inject(NablaStore);
  readonly event = input.required<DomainEvent>();
  readonly slug = input.required<string>();

  protected readonly bot = LucideBot;
  protected readonly v = computed(() => describeEvent(this.event(), this.store, this.slug()));
  protected readonly actorName = computed(() => this.store.actorName(this.event().actor));
  protected readonly isAgent = computed(() => this.event().actor.type === 'agent');
}
