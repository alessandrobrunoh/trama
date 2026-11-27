import type { EstimateScale, EstimateSuggestion } from '../contracts/domain.js';

/** Fewest similar finished tasks a suggestion is based on. */
export const SUGGESTION_MIN_BASIS = 2;
/** Most similar finished tasks kept as the basis. */
export const SUGGESTION_BASIS_MAX = 5;

/**
 * The values each workspace estimate scale offers, as the app shows them (`src/app/core/estimates.ts`).
 * `none` offers nothing: estimates are turned off.
 */
export const ESTIMATE_SCALE_VALUES: Record<EstimateScale, readonly number[]> = {
  none: [],
  linear: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  fibonacci: [0, 1, 2, 3, 5, 8, 13, 21],
  exponential: [1, 2, 4, 8, 16, 32],
  tshirt: [1, 2, 3, 5, 8],
};

/** What the target task is compared on. */
export interface SimilarityTarget {
  title: string;
  projectId: string | null;
  labels: readonly string[];
}

/** A finished task that has an estimate. */
export interface FinishedTask extends SimilarityTarget {
  id: string;
  key: string;
  estimate: number;
  trackedMinutes: number | null;
  /** Used to break ties: the most recently finished task wins. */
  completedAt: Date | null;
}

export type ScoredTask = FinishedTask & { score: number };

const PROJECT_WEIGHT = 10_000;
const LABEL_WEIGHT = 100;
const LABELS_COUNTED_MAX = 50;
const WORDS_COUNTED_MAX = 99;

/** Lowercased words of three or more letters (or digits) of a title. */
export function titleWords(title: string): Set<string> {
  const words = title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(words);
}

/**
 * How much a finished task resembles the target: the same project first, then shared labels, then
 * the words their titles share. `0` means nothing in common.
 */
export function similarity(target: SimilarityTarget, other: SimilarityTarget): number {
  const sameProject = !!target.projectId && target.projectId === other.projectId;
  const labels = new Set(target.labels);
  const sharedLabels = Math.min(
    other.labels.filter((label) => labels.has(label)).length,
    LABELS_COUNTED_MAX,
  );
  const words = titleWords(target.title);
  let sharedWords = 0;
  for (const word of titleWords(other.title)) if (words.has(word)) sharedWords++;
  return (
    (sameProject ? PROJECT_WEIGHT : 0) +
    sharedLabels * LABEL_WEIGHT +
    Math.min(sharedWords, WORDS_COUNTED_MAX)
  );
}

/** The finished tasks that resemble the target, best first (ties: finished most recently). */
export function rankSimilar(
  target: SimilarityTarget,
  candidates: readonly FinishedTask[],
  limit = SUGGESTION_BASIS_MAX,
): ScoredTask[] {
  return candidates
    .map((task): ScoredTask => ({ ...task, score: similarity(target, task) }))
    .filter((task) => task.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

/** Middle value; the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The scale value nearest to `value`. Halfway between two values, the larger one. */
export function snapToScale(value: number, scale: readonly number[]): number | null {
  let best: number | null = null;
  for (const candidate of scale) {
    if (
      best === null ||
      Math.abs(candidate - value) < Math.abs(best - value) ||
      (Math.abs(candidate - value) === Math.abs(best - value) && candidate > best)
    )
      best = candidate;
  }
  return best;
}

/** The suggestion for `target`, from the finished tasks that have an estimate. */
export function buildEstimateSuggestion(
  issueId: string,
  target: SimilarityTarget,
  candidates: readonly FinishedTask[],
  scaleName: EstimateScale,
): EstimateSuggestion {
  const scale = [...ESTIMATE_SCALE_VALUES[scaleName]];
  const ranked = rankSimilar(target, candidates);
  const basis = ranked.map((task) => ({
    id: task.id,
    key: task.key,
    title: task.title,
    estimate: task.estimate,
    trackedMinutes: task.trackedMinutes,
  }));
  if (!scale.length)
    return {
      issueId,
      suggestion: null,
      scale,
      basis,
      reason: 'Estimates are turned off in this workspace.',
    };
  if (ranked.length < SUGGESTION_MIN_BASIS)
    return {
      issueId,
      suggestion: null,
      scale,
      basis,
      reason: `Not enough history: ${ranked.length} similar finished task${
        ranked.length === 1 ? '' : 's'
      } with an estimate, at least ${SUGGESTION_MIN_BASIS} are needed.`,
    };
  const mid = median(ranked.map((task) => task.estimate));
  const suggestion = snapToScale(mid, scale);
  return {
    issueId,
    suggestion,
    scale,
    basis,
    reason:
      `Median estimate of the ${ranked.length} most similar finished tasks ` +
      `(${ranked.map((task) => task.estimate).join(', ')}) is ${mid}, ` +
      `snapped to ${suggestion} on the ${scaleName} scale. ` +
      'Similar means the same project, shared labels and shared title words.',
  };
}
