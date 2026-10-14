import type {
  Artifact,
  Decision,
  InputRequest,
  Issue,
  IssuePlan,
} from '../contracts/domain.js';

/** Row shapes the briefing reads; database entities (nullable columns) fit too. */
type Nullable<T> = { [K in keyof T]?: T[K] | null };

export interface IssueBriefingInput {
  issue: Pick<Issue, 'key' | 'title' | 'kind' | 'status' | 'priority'> &
    Nullable<Pick<Issue, 'body' | 'goal'>> & {
      externalRef?: Pick<
        NonNullable<Issue['externalRef']>,
        'provider' | 'id' | 'url' | 'key' | 'state'
      > | null;
    };
  plans: IssuePlan[];
  decisions: (Pick<Decision, 'id' | 'key' | 'title' | 'status' | 'statement'> &
    Nullable<Pick<Decision, 'rationale' | 'supersededById'>>)[];
  /** Open and answered requests; dismissed ones are not context. */
  inputRequests: (Pick<InputRequest, 'question' | 'state'> &
    Nullable<Pick<InputRequest, 'options' | 'answer'>>)[];
  artifacts: (Pick<Artifact, 'kind' | 'title' | 'state'> &
    Nullable<
      Pick<
        Artifact,
        'externalId' | 'url' | 'ci' | 'review' | 'hasConflicts' | 'environment'
      >
    >)[];
}

const words = (s: string) => s.replace(/_/g, ' ');
const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** One line of the Plan section: the plan, its revision and where its approval stands. */
function planLine(p: IssuePlan): string {
  const where = p.documentId ? `Trama document ${p.documentId}` : (p.url ?? 'no link');
  const rev = p.revision ? ` · rev ${p.revision}` : '';
  const state = p.changedSinceApproval
    ? `changed since approval (approved ${p.approved?.revision} in ${p.approved?.decisionKey})`
    : p.approved
      ? `approved${p.approved.revision ? ` at ${p.approved.revision}` : ''} (${p.approved.decisionKey})`
      : p.proposedDecisionKey
        ? `not approved yet: ${p.proposedDecisionKey} is proposed and waits for a person`
        : 'not approved';
  const pending =
    p.changedSinceApproval && p.proposedDecisionKey
      ? `; ${p.proposedDecisionKey} proposed and waiting for a person`
      : '';
  return `- ${p.title} — ${where}${rev} · ${state}${pending}`;
}

/**
 * Markdown handoff for one Issue: the high-density context a person or agent needs to pick the work up
 * ("where did we leave off?"), without the conversation that produced it. Pure, so it is easy to test.
 */
export function renderIssueBriefing(c: IssueBriefingInput): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push(`## ${title}`, '', ...lines, '');
  };
  const { issue } = c;

  out.push(
    `# ${issue.key} — ${issue.title}`,
    '',
    `Status: ${words(issue.status)} · Priority: ${issue.priority} · Kind: ${words(issue.kind)}`,
    '',
  );

  const openRequests = c.inputRequests.filter((r) => r.state === 'open');
  const proposed = c.decisions.filter((d) => d.status === 'proposed');
  const waiting = [
    ...openRequests.map((r) => `question: ${firstLine(r.question)}`),
    ...proposed.map((d) => `decision ${d.key} to accept or reject`),
  ];
  if (waiting.length) out.push(`> Waiting on a person: ${waiting.join('; ')}.`, '');

  const ref = issue.externalRef;
  if (ref) {
    out.push(
      `External: ${ref.provider} ${ref.key ?? ref.id}${ref.state ? ` (${ref.state})` : ''} — ${ref.url}`,
      '',
    );
  }

  section('Goal', issue.goal?.trim() ? [issue.goal.trim()] : []);
  section('Description', issue.body?.trim() ? [issue.body.trim()] : []);
  section('Plan', c.plans.map(planLine));

  const byId = new Map(c.decisions.map((d) => [d.id, d]));
  const line = (d: IssueBriefingInput['decisions'][number]) =>
    `- ${d.key} ${d.title}: ${firstLine(d.statement)}${d.rationale?.trim() ? ` — because ${firstLine(d.rationale)}` : ''}`;
  section('Decisions', [
    ...c.decisions.filter((d) => d.status === 'accepted').map(line),
    ...proposed.map((d) => `- ${d.key} ${d.title} — proposed, not yet accepted`),
    ...c.decisions
      .filter((d) => d.status === 'superseded')
      .map((d) => {
        const by = d.supersededById ? byId.get(d.supersededById)?.key : undefined;
        return `- ${d.key} ${d.title} — superseded${by ? ` by ${by}` : ''}; do not follow`;
      }),
  ]);

  section('Human input', [
    ...openRequests.map(
      (r) =>
        `- Open: ${firstLine(r.question)}${r.options?.length ? ` [options: ${r.options.join(' / ')}]` : ''}`,
    ),
    ...c.inputRequests
      .filter((r) => r.state === 'answered')
      .map((r) => `- Answered: ${firstLine(r.question)} → ${firstLine(r.answer ?? '')}`),
  ]);

  section(
    'Artifacts',
    c.artifacts.map((a) => {
      const bits = [
        a.state,
        a.ci ? `CI ${a.ci}` : '',
        a.review && a.review !== 'none' ? `review ${words(a.review)}` : '',
        a.hasConflicts ? 'has conflicts' : '',
        a.environment ?? '',
      ].filter(Boolean);
      return `- ${words(a.kind)}${a.externalId ? ` ${a.externalId}` : ''}: ${a.title}${a.url ? ` — ${a.url}` : ''} (${bits.join(', ')})`;
    }),
  );

  return `${out.join('\n').trimEnd()}\n`;
}
