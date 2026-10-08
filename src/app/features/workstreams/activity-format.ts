// Turns DomainEvents into short sentences + icons (activity feed, execution timeline).
import {
  LucideCheck,
  LucideCircleDot,
  LucideCircleHelp,
  LucideFilePlus,
  LucideGitPullRequest,
  LucideGavel,
  LucideInbox,
  LucideLink,
  LucideListChecks,
  LucideMessageSquare,
  LucidePencil,
  LucideRefreshCw,
  LucideSparkles,
  LucideWorkflow,
  type LucideIcon,
} from '@lucide/angular';
import { WORKSTREAM_STATUS_META, type DomainEvent, type NablaStore } from '../../core';

export interface EventLine {
  icon: LucideIcon;
  /** Sentence after the actor's name, e.g. "reported progress". */
  verb: string;
  /** Quoted secondary text (note, title, excerpt). */
  detail?: string;
  /** Route segments under the workspace (`['executions', id]`) to open the subject. */
  link?: string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function stateLabel(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  return (
    (WORKSTREAM_STATUS_META as Record<string, { label: string }>)[s]?.label ?? s.replace(/_/g, ' ')
  );
}

export function describeEvent(store: NablaStore, ev: DomainEvent): EventLine {
  const d = ev.data;
  const title = str(d['title']);
  const subjectLink = (): string[] | undefined => {
    switch (ev.subject.type) {
      case 'decision': {
        const key = str(d['key']) ?? store.getDecision(ev.subject.id)?.key;
        return key ? ['decisions', key] : undefined;
      }
      case 'issue': {
        const key = str(d['key']) ?? store.getIssue(ev.subject.id)?.key;
        return key ? ['issues', key] : undefined;
      }
      default:
        return undefined;
    }
  };
  switch (ev.type) {
    case 'workstream.created':
      return { icon: LucideSparkles, verb: 'created this workstream' };
    case 'workstream.updated': {
      const fields = Array.isArray(d['fields']) ? (d['fields'] as string[]) : [];
      return { icon: LucidePencil, verb: fields.length ? `updated ${fields.map(fieldName).join(', ')}` : 'updated the workstream' };
    }
    case 'workstream.status_changed':
      return {
        icon: LucideRefreshCw,
        verb: `moved status to ${stateLabel(d['to'])}${d['from'] ? ` (from ${stateLabel(d['from'])})` : ''}`,
      };
    case 'criterion.updated':
      return {
        icon: LucideListChecks,
        verb:
          d['change'] === 'added'
            ? 'added an acceptance criterion'
            : d['change'] === 'removed'
              ? 'removed an acceptance criterion'
              : `marked a criterion ${stateLabel(d['state']).toLowerCase()}`,
        detail: str(d['text']),
      };
    case 'execution.created':
      return { icon: LucideWorkflow, verb: 'started an execution', detail: title, link: subjectLink() };
    case 'execution.state_changed':
      return {
        icon: LucideCircleDot,
        verb: `moved an execution to ${stateLabel(d['to']).toLowerCase()}`,
        detail: title,
        link: subjectLink(),
      };
    case 'execution.progress':
      return { icon: LucideCircleDot, verb: 'reported progress', detail: str(d['note']) ?? title, link: subjectLink() };
    case 'input.requested':
      return { icon: LucideCircleHelp, verb: 'asked for input', detail: str(d['question']) };
    case 'input.answered':
      return { icon: LucideCheck, verb: 'answered an input request', detail: str(d['answer']) };
    case 'artifact.attached':
      return {
        icon: LucideGitPullRequest,
        verb: `attached ${str(d['kind'])?.replace(/_/g, ' ') ?? 'an artifact'}`,
        detail: [str(d['externalId']), title].filter(Boolean).join(' · '),
      };
    case 'artifact.updated': {
      const ch = (d['changes'] ?? {}) as Record<string, [unknown, unknown]>;
      const bits = Object.entries(ch).map(([k, v]) => `${k} → ${String(Array.isArray(v) ? v[1] : v)}`);
      return { icon: LucideGitPullRequest, verb: 'updated an artifact', detail: [str(d['externalId']) ?? title, bits.join(', ')].filter(Boolean).join(' · ') };
    }
    case 'review.requested':
      return { icon: LucideGitPullRequest, verb: 'requested a review', detail: [str(d['externalId']), title].filter(Boolean).join(' · ') };
    case 'decision.proposed':
      return { icon: LucideGavel, verb: 'proposed a decision', detail: [str(d['key']), title].filter(Boolean).join(' · '), link: subjectLink() };
    case 'decision.accepted':
      return { icon: LucideGavel, verb: 'accepted a decision', detail: [str(d['key']), title].filter(Boolean).join(' · '), link: subjectLink() };
    case 'decision.rejected':
      return { icon: LucideGavel, verb: 'rejected a decision', detail: [str(d['key']), title].filter(Boolean).join(' · '), link: subjectLink() };
    case 'decision.superseded':
      return { icon: LucideGavel, verb: 'superseded a decision', detail: [str(d['key']), title].filter(Boolean).join(' · '), link: subjectLink() };
    case 'issue.created':
      return { icon: LucideInbox, verb: 'opened an issue', detail: [str(d['key']), title].filter(Boolean).join(' · '), link: subjectLink() };
    case 'issue.status_changed':
      return {
        icon: LucideInbox,
        verb: `moved an issue to ${stateLabel(d['to']).toLowerCase()}`,
        detail: [str(d['key']), title].filter(Boolean).join(' · '),
        link: subjectLink(),
      };
    case 'issue.linked':
      return { icon: LucideInbox, verb: 'linked an issue to this workstream', detail: [str(d['key']), title].filter(Boolean).join(' · '), link: subjectLink() };
    case 'dependency.added':
      return { icon: LucideLink, verb: 'added a dependency' };
    case 'comment.created':
      return { icon: LucideMessageSquare, verb: 'commented', detail: str(d['excerpt']), link: subjectLink() };
    default:
      return { icon: LucideFilePlus, verb: ev.type.replace(/[._]/g, ' '), detail: title };
  }
}

function fieldName(f: string): string {
  const map: Record<string, string> = {
    statusOverride: 'the status override',
    ownerTeamId: 'the owner team',
    participatingTeamIds: 'participating teams',
    accountableUserId: 'the accountable person',
    repositoryIds: 'projects',
    targetDate: 'the target date',
    objective: 'the objective',
    context: 'the context',
    acceptanceCriteria: 'acceptance criteria',
  };
  return map[f] ?? f;
}
