import type { Artifact, Issue } from '../contracts/domain.js';

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
  artifacts: (Pick<Artifact, 'kind' | 'title' | 'state'> &
    Nullable<
      Pick<
        Artifact,
        'externalId' | 'url' | 'ci' | 'review' | 'hasConflicts' | 'environment'
      >
    >)[];
}

const words = (s: string) => s.replace(/_/g, ' ');

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

  const ref = issue.externalRef;
  if (ref) {
    out.push(
      `External: ${ref.provider} ${ref.key ?? ref.id}${ref.state ? ` (${ref.state})` : ''} — ${ref.url}`,
      '',
    );
  }

  section('Goal', issue.goal?.trim() ? [issue.goal.trim()] : []);
  section('Description', issue.body?.trim() ? [issue.body.trim()] : []);
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
