import type {
  AcceptanceCriterion,
  ActorRef,
  CriterionEvidence,
  CriterionState,
} from '../contracts/domain.js';
import { uid } from '../common/util.js';

export interface CriterionInput {
  id?: string;
  text: string;
  state?: CriterionState;
}

export interface CriterionPatch {
  text?: string;
  state?: CriterionState;
  /** `null` (or an empty value) clears the evidence. */
  evidence?: { artifactIds?: string[]; note?: string | null } | null;
}

/** Stored shape of evidence: de-duplicated ids and a trimmed note; `undefined` when nothing is left. */
export function normalizeEvidence(
  e: CriterionPatch['evidence'],
): CriterionEvidence | undefined {
  if (!e) return undefined;
  const artifactIds = [...new Set(e.artifactIds ?? [])];
  const note = e.note?.trim();
  if (!artifactIds.length && !note) return undefined;
  return { artifactIds, ...(note ? { note } : {}) };
}

/**
 * The one place a criterion changes. Rules:
 * - becoming `met` records who and when (`verifiedBy` / `verifiedAt`); leaving `met` clears both;
 * - editing the text of a `met` criterion resets it to `pending` and drops its verification and
 *   evidence (the proof was for the old wording), unless the same change sets the state itself;
 * - evidence is replaced only when the patch carries `evidence`; linking proof never changes `state`.
 */
export function applyCriterionChange(
  current: AcceptanceCriterion,
  patch: CriterionPatch,
  actor: ActorRef,
  now: Date = new Date(),
): AcceptanceCriterion {
  const text = patch.text !== undefined ? patch.text.trim() : current.text;
  const textEdited = text !== current.text;
  let state = patch.state ?? current.state;
  if (textEdited && current.state === 'met' && patch.state === undefined)
    state = 'pending';

  const { evidence: oldEvidence, verifiedBy, verifiedAt, ...rest } = current;
  let evidence = oldEvidence;
  if (patch.evidence !== undefined) evidence = normalizeEvidence(patch.evidence);
  else if (textEdited && current.state === 'met') evidence = undefined;

  const next: AcceptanceCriterion = { ...rest, text, state };
  if (evidence) next.evidence = evidence;
  if (state === 'met') {
    if (current.state === 'met' && !textEdited) {
      // Already met: whoever set it stays the verifier (older criteria have none, and stay that way).
      if (verifiedBy) next.verifiedBy = verifiedBy;
      if (verifiedAt) next.verifiedAt = verifiedAt;
    } else {
      next.verifiedBy = { type: actor.type, ...(actor.id ? { id: actor.id } : {}) };
      next.verifiedAt = now.toISOString();
    }
  }
  return next;
}

/** A brand new criterion; `met` from the start is verified by its creator. */
export function newCriterion(
  input: CriterionInput,
  actor: ActorRef,
  now: Date = new Date(),
): AcceptanceCriterion {
  return applyCriterionChange(
    { id: input.id ?? uid('ac'), text: '', state: 'pending' },
    { text: input.text, state: input.state ?? 'pending' },
    actor,
    now,
  );
}

/**
 * Full replacement of the list (create / update of the workstream). Criteria that keep their id
 * keep their evidence and verification, and follow the same rules as {@link applyCriterionChange}.
 */
export function replaceCriteria(
  items: CriterionInput[] | undefined,
  existing: readonly AcceptanceCriterion[],
  actor: ActorRef,
  now: Date = new Date(),
): AcceptanceCriterion[] {
  const byId = new Map(existing.map((c) => [c.id, c]));
  return (items ?? []).map((c) => {
    const current = c.id ? byId.get(c.id) : undefined;
    return current
      ? applyCriterionChange(current, { text: c.text, state: c.state ?? 'pending' }, actor, now)
      : newCriterion(c, actor, now);
  });
}
