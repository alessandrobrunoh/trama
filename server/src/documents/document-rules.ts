import { DOCUMENT_LIMITS, type ActorRef } from '../contracts/domain.js';

/** Sentinels `ts_headline` puts around a match; replaced by `<mark>` once the text is escaped. */
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

const TERM_RE = /[\p{L}\p{N}]+/gu;
const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 64;

/**
 * A `to_tsquery('simple', …)` string for what a person typed: every word must match as a prefix
 * (`spec pla` finds "Specification plan"). Only letters and digits survive, so nothing the user types
 * can be an operator. `null` when there is nothing to search for.
 */
export function buildTsQuery(input: string | undefined): string | null {
  const terms = (input ?? '').match(TERM_RE)?.slice(0, MAX_TERMS);
  if (!terms?.length) return null;
  return terms
    .map((t) => `${t.slice(0, MAX_TERM_LENGTH).toLowerCase()}:*`)
    .join(' & ');
}

/** The first characters of a markdown body as plain text, for list rows. */
export function excerptOf(body: string | null | undefined, max = 180): string {
  const text = (body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[\s|:-]*\|[\s|:-]*$/gm, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * `ts_headline` output (matches wrapped in the sentinels) as HTML that is safe to render: everything the
 * document contained is escaped, only the `<mark>` tags are ours.
 */
export function snippetToHtml(
  raw: string | null | undefined,
): string | undefined {
  if (!raw) return undefined;
  const escaped = raw.replace(/[&<>"']/g, (c) => ESCAPES[c]);
  return escaped
    .replaceAll(MARK_START, '<mark>')
    .replaceAll(MARK_END, '</mark>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.type === b.type && a.id === b.id;
}

/** Title as stored: one line, trimmed. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Do two saves go into one revision? Yes when the same actor saved the newest revision less than the window
 * ago, so a minute of autosaves is one entry in the history and not sixty.
 */
export function mergesIntoHead(
  head: { editor: ActorRef; createdAt: Date } | null | undefined,
  editor: ActorRef,
  now: Date,
  windowMs: number = DOCUMENT_LIMITS.revisionWindowMs,
): boolean {
  return (
    !!head &&
    sameActor(head.editor, editor) &&
    now.getTime() - head.createdAt.getTime() < windowMs
  );
}

/** One emoji (pictograph with modifiers / ZWJ sequence, or a flag): what a document may use as icon. */
const EMOJI = new RegExp(
  '^(?:\\p{Extended_Pictographic}(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])?)*|\\p{Regional_Indicator}{2})$',
  'u',
);

export function isEmoji(value: string): boolean {
  return value.length <= 32 && EMOJI.test(value);
}
