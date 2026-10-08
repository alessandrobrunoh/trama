// Instant, offline triage hints read straight from what the person typed ("priorità alta", "bug",
// "stima 5"). They show while the AI is still thinking (or when it is not configured) and are
// replaced per field by the AI's answer. Pure: no Angular.

import type { AiIssueDraftOptions, AiIssueDraftSuggestion } from '../../core/ai/ai-api';

const norm = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

const PRIORITY_RULES: readonly [string, RegExp][] = [
  ['urgent', /\b(urgent[ei]?|asap|subito|blocker|bloccante|p0)\b/],
  [
    'high',
    /\b(prio\w*\s*(?:e\s*)?(?:alta|high)|(?:alta|high)\s*prio\w*|importante|important|p1)\b/,
  ],
  ['low', /\b(prio\w*\s*(?:e\s*)?(?:bassa|low)|(?:bassa|low)\s*prio\w*|non urgente|p3)\b/],
  ['medium', /\b(prio\w*\s*(?:e\s*)?(?:media|medium)|(?:media|medium)\s*prio\w*|p2)\b/],
];

const KIND_RULES: readonly [string, RegExp][] = [
  ['incident', /\b(incident|outage|down|incidente)\b/],
  ['security', /\b(security|sicurezza|vulnerabilit\w*|cve)\b/],
  ['bug', /\b(bug|error[ei]?|crash\w*|rott[oa]|non funziona|broken|regression\w*)\b/],
  ['tech_debt', /\b(tech[\s_-]?debt|debito tecnico|refactor\w*|cleanup)\b/],
  ['feedback', /\b(feedback|richiesta cliente|customer request)\b/],
  ['idea', /\b(idea|proposta|proposal)\b/],
  ['feature', /\b(feature|funzionalita|da impl\w*|implement\w*|nuov[oa])\b/],
];

const ESTIMATE_RULES: readonly RegExp[] = [
  /\b(?:stima|estimate|estimation|sp|story points?)\s*(?:di|of|:)?\s*(\d{1,2})\b/,
  /\b(\d{1,2})\s*(?:punti|points?|pt|sp)\b/,
  /\b(?:ci metto|ci metter\w*|takes?|will take)\s*(?:come stima\s*)?(\d{1,2})\b/,
];

const SIZE_TO_POINTS: Record<string, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 };

/** The scale value closest to `wanted` (the person may type 4 on a fibonacci scale). */
function nearest(values: readonly number[], wanted: number): number | undefined {
  let best: number | undefined;
  for (const v of values)
    if (best === undefined || Math.abs(v - wanted) < Math.abs(best - wanted)) best = v;
  return best;
}

export function localTriage(
  title: string,
  description: string,
  options: Pick<AiIssueDraftOptions, 'kinds' | 'priorities' | 'estimates' | 'workstreams'>,
): AiIssueDraftSuggestion[] {
  const text = norm(`${title}\n${description}`);
  if (text.trim().length < 3) return [];
  const out: AiIssueDraftSuggestion[] = [];

  const priority = PRIORITY_RULES.find(
    ([value, re]) => options.priorities.includes(value) && re.test(text),
  );
  if (priority)
    out.push({ field: 'priority', value: priority[0], why: 'You mention the priority.' });

  const kind = KIND_RULES.find(([value, re]) => options.kinds.includes(value) && re.test(text));
  if (kind) out.push({ field: 'kind', value: kind[0], why: 'Matches the words you used.' });

  if (options.estimates.length) {
    let wanted: number | undefined;
    for (const re of ESTIMATE_RULES) {
      const m = re.exec(text);
      if (m) {
        wanted = Number(m[1]);
        break;
      }
    }
    if (wanted === undefined) {
      const size = /\b(?:taglia|size)\s*(xs|s|m|l|xl)\b/.exec(text);
      if (size) wanted = SIZE_TO_POINTS[size[1]];
    }
    const value = wanted === undefined ? undefined : nearest(options.estimates, wanted);
    if (value !== undefined)
      out.push({ field: 'estimate', value, why: 'You mention the estimate.' });
  }

  return out;
}
