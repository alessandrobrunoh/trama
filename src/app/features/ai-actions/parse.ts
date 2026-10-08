// Robust parsing of what the model sends back. Pure: no Angular. Models wrap JSON in code
// fences, add a sentence before it, or leave a trailing comma; `extractJson` copes with the
// common cases and the validators below turn `unknown` into typed results (no `any`). Anything
// that cannot be trusted throws `AiFormatError` with a message that is fine to show people.
import type { IssueKind, Priority } from '../../core/contracts/domain';

export const FORMAT_MESSAGE = 'AI returned an unexpected format — try again';

export class AiFormatError extends Error {
  override readonly name = 'AiFormatError';
  constructor() {
    super(FORMAT_MESSAGE);
  }
}

export const PRIORITY_VALUES: readonly Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];
export const KIND_VALUES: readonly IssueKind[] = ['bug', 'feature', 'incident', 'tech_debt', 'feedback', 'idea', 'security'];

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** First balanced `{…}` or `[…]` in `text` that parses, honouring strings and escapes. */
function balanced(text: string, from: number): string | null {
  const open = text[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    // trailing commas are the one sloppy habit worth forgiving
    try {
      return { ok: true, value: JSON.parse(s.replace(/,\s*([}\]])/g, '$1')) as unknown };
    } catch {
      return { ok: false };
    }
  }
}

/** Parse the JSON value in a model reply: plain, ```json fenced, or surrounded by prose. */
export function extractJson(text: string): unknown {
  const raw = text.trim();
  if (!raw) throw new AiFormatError();
  const direct = tryParse(raw);
  if (direct.ok) return direct.value;

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(raw);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner.ok) return inner.value;
  }
  // an unterminated fence ("```json\n{…}") or leading prose: scan for the first balanced value
  let tries = 0;
  for (let i = 0; i < raw.length && tries < 4; i++) {
    if (raw[i] !== '{' && raw[i] !== '[') continue;
    tries++;
    const chunk = balanced(raw, i);
    if (!chunk) continue;
    const parsed = tryParse(chunk);
    if (parsed.ok) return parsed.value;
  }
  throw new AiFormatError();
}

// ───────────────────────────── field helpers ─────────────────────────────

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function textList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = text(typeof x === 'string' ? x.replace(/^\s*[-*•]\s+/, '') : x, maxLen);
    if (t) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  if (typeof v !== 'string') return undefined;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return list.find((x) => x === k);
}

/** The 'why' sentence next to a suggestion. */
const why = (v: unknown): string => text(v, 200) ?? '';

// ───────────────────────────── results ─────────────────────────────

export interface Summary {
  tldr: string;
  unclear: string[];
}

export function parseSummary(reply: string): Summary {
  const json = extractJson(reply);
  if (!isRecord(json)) throw new AiFormatError();
  const tldr = text(json['tldr'] ?? json['summary'], 700);
  if (!tldr) throw new AiFormatError();
  return { tldr, unclear: textList(json['unclear'] ?? json['missing'], 3, 200) };
}

export interface Suggestion<T> {
  value: T;
  why: string;
}

export interface Triage {
  priority?: Suggestion<Priority>;
  estimate?: Suggestion<number>;
  kind?: Suggestion<IssueKind>;
  workstreams: { key: string; why: string }[];
}

export interface TriageContext {
  /** Allowed estimate values; empty or missing when the workspace has no estimates. */
  estimates: readonly number[];
  /** Keys of the workstreams that were offered as candidates. */
  candidateKeys: readonly string[];
}

export function parseTriage(reply: string, ctx: TriageContext): Triage {
  const json = extractJson(reply);
  if (!isRecord(json)) throw new AiFormatError();
  const out: Triage = { workstreams: [] };

  const p = json['priority'];
  if (isRecord(p)) {
    const value = oneOf(PRIORITY_VALUES, p['value']);
    if (value) out.priority = { value, why: why(p['why']) };
  }
  const k = json['kind'];
  if (isRecord(k)) {
    const value = oneOf(KIND_VALUES, k['value']);
    if (value) out.kind = { value, why: why(k['why']) };
  }
  const e = json['estimate'];
  if (isRecord(e) && ctx.estimates.length) {
    const n = typeof e['value'] === 'number' ? e['value'] : Number(e['value']);
    if (Number.isFinite(n) && ctx.estimates.includes(n)) out.estimate = { value: n, why: why(e['why']) };
  }
  const ws = json['workstreams'];
  if (Array.isArray(ws)) {
    const allowed = new Map(ctx.candidateKeys.map((k2) => [k2.toUpperCase(), k2]));
    const seen = new Set<string>();
    for (const w of ws) {
      const key = isRecord(w) ? text(w['key'], 40) : typeof w === 'string' ? text(w, 40) : undefined;
      const real = key ? allowed.get(key.toUpperCase()) : undefined;
      if (!real || seen.has(real)) continue;
      seen.add(real);
      out.workstreams.push({ key: real, why: isRecord(w) ? why(w['why']) : '' });
      if (out.workstreams.length >= 3) break;
    }
  }
  return out;
}

export function triageIsEmpty(t: Triage): boolean {
  return !t.priority && !t.estimate && !t.kind && t.workstreams.length === 0;
}

export interface ProposedIssue {
  title: string;
  kind: IssueKind;
  priority: Priority;
  estimate: number | null;
  description: string;
}

export interface BreakdownContext {
  estimates: readonly number[];
  existingTitles: readonly string[];
}

/** Lower-case, no punctuation: the key used to spot duplicate titles. */
export function titleKey(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function parseBreakdown(reply: string, ctx: BreakdownContext): ProposedIssue[] {
  const json = extractJson(reply);
  const list = Array.isArray(json) ? json : isRecord(json) ? json['issues'] : undefined;
  if (!Array.isArray(list)) throw new AiFormatError();
  const seen = new Set(ctx.existingTitles.map(titleKey));
  const out: ProposedIssue[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const title = text(raw['title'], 120);
    if (!title) continue;
    const key = titleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const n = raw['estimate'] === null || raw['estimate'] === undefined ? null : Number(raw['estimate']);
    out.push({
      title,
      kind: oneOf(KIND_VALUES, raw['kind']) ?? 'feature',
      priority: oneOf(PRIORITY_VALUES, raw['priority']) ?? 'none',
      estimate: n !== null && Number.isFinite(n) && ctx.estimates.includes(n) ? n : null,
      description: text(raw['description'], 400) ?? '',
    });
    if (out.length >= 7) break;
  }
  return out;
}

/** A markdown reply (status update, digest). Accepts `{"markdown": "…"}` or bare markdown with headings. */
export function parseMarkdown(reply: string, max = 4000): string {
  let md: string | undefined;
  try {
    const json = extractJson(reply);
    if (isRecord(json)) {
      const v = json['markdown'] ?? json['update'] ?? json['text'] ?? json['content'];
      if (typeof v === 'string') md = v;
    } else if (typeof json === 'string') md = json;
  } catch {
    // not JSON: fall through to the bare markdown check
  }
  if (md === undefined && /^\s*#{1,4}\s+\S/m.test(reply)) {
    md = reply.replace(/^\s*```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');
  }
  const clean = md?.replace(/\r/g, '').trim();
  if (!clean || clean.length < 8) throw new AiFormatError();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
