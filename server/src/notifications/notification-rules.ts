import type { ActorRef, NotificationKind, SubjectRef, WorkstreamStatus } from '../contracts/domain.js';

/** The slice of a recorded DomainEvent the rules need. */
export interface RuleEvent {
  type: string;
  actor: ActorRef;
  subject: SubjectRef;
  data: Record<string, unknown>;
}

/** Records the rules may refer to. The service loads whichever the event is about. */
export interface RuleContext {
  event: RuleEvent;
  /** Display name of whoever caused the event. */
  actorName: string;
  issue?: { id: string; key: string; title: string; assigneeId?: string | null; reporterId?: string | null };
  /** The event's workstream, or the subject itself when the event is about a workstream. */
  workstream?: { id: string; key: string; title: string; accountableUserId?: string | null };
  decision?: { id: string; key: string; title: string };
  /** The customer a `customer_request.*` event is about, with the people following it. */
  customer?: { id: string; name: string; subscriberIds: readonly string[] };
  /**
   * What an issue or project that just got delivered (issue done, project completed) was asked for:
   * the customers behind its requests, who follows them, and who recorded the requests.
   */
  delivery?: {
    target: { type: 'issue' | 'project'; id: string; label: string; link: string };
    customers: readonly { id: string; name: string; subscriberIds: readonly string[] }[];
    requesterIds: readonly string[];
  };
}

/** One message for one person, before settings and delivery are applied. */
export interface NotificationDraft {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Relative to the workspace, e.g. `issues/BUG-142`. */
  link: string;
  subject: SubjectRef;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const STATUS_PHRASE: Partial<Record<WorkstreamStatus, string>> = {
  shipped: 'shipped',
  blocked: 'is blocked',
  ready_to_land: 'is ready to land',
};

/**
 * Who should hear about an event, and what to tell them. Pure: no database, no delivery.
 * The actor never hears about their own action. Callers still apply membership and each
 * person's settings.
 */
export function planNotifications(ctx: RuleContext): NotificationDraft[] {
  const { event, actorName, issue, workstream, decision } = ctx;
  const drafts: NotificationDraft[] = [];
  const add = (userId: string | null | undefined, draft: Omit<NotificationDraft, 'userId'>) => {
    if (userId) drafts.push({ userId, ...draft });
  };
  const { customer, delivery } = ctx;
  const wsLink = workstream ? `workstreams/${workstream.key}` : undefined;
  const accountable = workstream?.accountableUserId;

  switch (event.type) {
    case 'issue.created': {
      add(asString(event.data['assigneeId']), assigned(issue, actorName));
      break;
    }
    case 'issue.updated': {
      const change = event.data['assignee'] as { to?: string | null } | undefined;
      add(asString(change?.to), assigned(issue, actorName));
      break;
    }
    case 'input.requested': {
      if (!workstream || !wsLink) break;
      add(asString(event.data['assigneeUserId']) ?? accountable, {
        kind: 'input_requested',
        title: `${actorName} asked a question on ${workstream.key}`,
        body: asString(event.data['question']),
        link: wsLink,
        subject: event.subject,
      });
      break;
    }
    case 'decision.proposed': {
      if (!decision) break;
      add(accountable, {
        kind: 'decision_proposed',
        title: `${actorName} proposed ${decision.key}: ${decision.title}`,
        body: workstream ? `${workstream.key} · ${workstream.title}` : undefined,
        link: `decisions/${decision.key}`,
        subject: event.subject,
      });
      break;
    }
    case 'review.requested': {
      if (!workstream || !wsLink) break;
      add(accountable, {
        kind: 'review_requested',
        title: `Review requested: ${asString(event.data['title']) ?? 'a pull request'}`,
        body: `${workstream.key} · ${workstream.title}`,
        link: wsLink,
        subject: event.subject,
      });
      break;
    }
    case 'artifact.updated': {
      const ci = (event.data['changes'] as Record<string, [unknown, unknown]> | undefined)?.['ci'];
      if (!workstream || !wsLink || ci?.[1] !== 'failing') break;
      add(accountable, {
        kind: 'ci_failed',
        title: `Checks are failing: ${asString(event.data['title']) ?? 'a pull request'}`,
        body: `${workstream.key} · ${workstream.title}`,
        link: wsLink,
        subject: event.subject,
      });
      break;
    }
    case 'comment.created': {
      const excerpt = asString(event.data['excerpt']);
      if (event.subject.type === 'issue' && issue) {
        const draft = {
          kind: 'comment' as const,
          title: `${actorName} commented on ${issue.key}: ${issue.title}`,
          body: excerpt,
          link: `issues/${issue.key}`,
          subject: event.subject,
        };
        add(issue.assigneeId, draft);
        add(issue.reporterId, draft);
      } else if (event.subject.type === 'decision' && decision) {
        add(accountable, {
          kind: 'comment',
          title: `${actorName} commented on ${decision.key}: ${decision.title}`,
          body: excerpt,
          link: `decisions/${decision.key}`,
          subject: event.subject,
        });
      } else if (workstream && wsLink) {
        add(accountable, {
          kind: 'comment',
          title: `${actorName} commented on ${workstream.key}: ${workstream.title}`,
          body: excerpt,
          link: wsLink,
          subject: event.subject,
        });
      }
      break;
    }
    case 'workstream.status_changed': {
      const phrase = STATUS_PHRASE[event.data['to'] as WorkstreamStatus];
      if (!workstream || !wsLink || !phrase) break;
      add(accountable, {
        kind: 'workstream_update',
        title: `${workstream.key} ${phrase}`,
        body: workstream.title,
        link: wsLink,
        subject: event.subject,
      });
      break;
    }
    case 'customer_request.linked':
    case 'customer_request.updated': {
      if (!customer) break;
      const created = event.type === 'customer_request.linked';
      if (!created && !(asStrings(event.data['fields']).includes('important') && event.data['important'] === true)) break;
      const target = asString(event.data['issueKey']) ?? asString(event.data['project']) ?? 'a request';
      const important = event.data['important'] === true;
      const draft = {
        // Added already flagged: one message, the stronger one.
        kind: important ? ('customer_important' as const) : ('customer_request' as const),
        title: created
          ? `${actorName} added ${important ? 'an important ' : 'a '}request from ${customer.name}: ${target}`
          : `${actorName} flagged a request from ${customer.name} as important: ${target}`,
        body: asString(event.data['excerpt']),
        link: `customers/${customer.id}`,
        subject: { type: 'customer' as const, id: customer.id },
      };
      for (const userId of customer.subscriberIds) add(userId, draft);
      break;
    }
    case 'issue.status_changed':
    case 'project.status_changed': {
      if (!delivery || !delivery.customers.length) break;
      const names = delivery.customers.map((c) => c.name);
      const who =
        names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
      const draft = {
        kind: 'customer_delivered' as const,
        title: `${delivery.target.label} was delivered: ${who} asked for it`,
        link: delivery.target.link,
        subject: { type: delivery.target.type, id: delivery.target.id },
      };
      for (const c of delivery.customers) for (const userId of c.subscriberIds) add(userId, draft);
      for (const userId of delivery.requesterIds) add(userId, draft);
      break;
    }
  }

  // The actor never hears about their own action; one message per person and kind.
  const actorId = event.actor.type === 'user' ? event.actor.id : undefined;
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = `${d.userId}:${d.kind}`;
    if (d.userId === actorId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function assigned(issue: RuleContext['issue'], actorName: string): Omit<NotificationDraft, 'userId'> {
  return {
    kind: 'assigned',
    title: issue ? `${actorName} assigned you ${issue.key}: ${issue.title}` : `${actorName} assigned you an issue`,
    link: issue ? `issues/${issue.key}` : 'issues',
    subject: { type: 'issue', id: issue?.id ?? '' },
  };
}
