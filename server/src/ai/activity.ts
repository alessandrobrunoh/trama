/** What the assistant did while preparing a reply; shown collapsed under the answer. */
export interface ActivityStep {
  kind: 'note' | 'read' | 'write';
  /** Human-readable, e.g. "Looked at issues"; for notes, the model's own words. */
  label: string;
  /** Set to false when the step failed or was refused (always present on writes). */
  ok?: boolean;
  /** Consecutive identical steps are merged. */
  count?: number;
  /** Failed writes: why (the API's message, shortened). */
  detail?: string;
}

export interface Activity {
  seconds: number;
  steps: ActivityStep[];
}

const VERBS: Record<string, string> = {
  list: 'Looked at',
  get: 'Looked at',
  search: 'Searched',
  create: 'Created',
  add: 'Added',
  update: 'Updated',
  change: 'Updated',
  reorder: 'Reordered',
  link: 'Linked',
  answer: 'Answered',
  dismiss: 'Dismissed',
  snooze: 'Snoozed',
  restore: 'Restored',
  delete: 'Deleted',
  remove: 'Removed',
  revoke: 'Revoked',
  accept: 'Accepted',
  reject: 'Rejected',
  supersede: 'Superseded',
};

/** `create_issue` → "Created issue", `list_input_requests` → "Looked at input requests". */
export function describeTool(name: string): string {
  if (name === 'whoami') return 'Checked its permissions';
  const [verb, ...rest] = name.split('_');
  const noun = rest.join(' ');
  const past = VERBS[verb] ?? 'Used';
  if (verb === 'search') return noun ? `Searched ${noun}` : 'Searched the workspace';
  return noun ? `${past} ${noun}` : past;
}

/** Longer text is the model thinking out loud, not a status line for the user. */
const MAX_NOTE = 280;
const MAX_DETAIL = 200;

/** Collects steps in order, merging consecutive duplicates. */
export class ActivityLog {
  private readonly started = Date.now();
  private readonly steps: ActivityStep[] = [];

  note(text: string): void {
    const label = text.trim();
    if (label && label.length <= MAX_NOTE) this.steps.push({ kind: 'note', label });
  }

  tool(name: string, write: boolean, ok = true, error?: string): void {
    const label = describeTool(name);
    const kind = write ? 'write' : 'read';
    const showOk = write || !ok; // a successful read needs no mark, a failed one does
    const last = this.steps.at(-1);
    if (last && last.kind === kind && last.label === label && last.ok === (showOk ? ok : undefined) && !last.detail && !error) {
      last.count = (last.count ?? 1) + 1;
      return;
    }
    const detail = !ok && error ? error.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL) : undefined;
    this.steps.push({ kind, label, ...(showOk ? { ok } : {}), ...(detail ? { detail } : {}) });
  }

  result(): Activity | undefined {
    if (!this.steps.some((s) => s.kind !== 'note')) return undefined;
    return { seconds: Math.max(1, Math.round((Date.now() - this.started) / 1000)), steps: this.steps.slice(0, 60) };
  }
}
