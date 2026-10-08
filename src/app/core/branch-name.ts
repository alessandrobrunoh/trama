// Git branch names for issues and workstreams ("Copy git branch name"), pure and framework-free.

export type BranchFormat = 'user/key-title' | 'key-title' | 'feature/key-title';

export const BRANCH_FORMATS: readonly BranchFormat[] = ['user/key-title', 'key-title', 'feature/key-title'];
export const DEFAULT_BRANCH_FORMAT: BranchFormat = 'user/key-title';

/** Title part budget (characters) and the soft cap for the whole branch name. */
export const BRANCH_TITLE_MAX = 50;
export const BRANCH_TOTAL_MAX = 70;

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th' };

/** lowercase, accents stripped, non-alphanumerics → "-", collapsed and trimmed. */
export function slugify(input: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ßæœøđłþ]/g, (c) => FOLD[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Cut a slug to `max` characters at a word ("-") boundary; a single oversized word is cut hard. */
export function clipSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const at = cut.lastIndexOf('-');
  const clipped = at > 0 ? cut.slice(0, at) : slug.slice(0, max);
  return clipped.replace(/-+$/g, '');
}

/** First name as a branch-safe handle: "Alessandro Bruno" → "alessandro". */
export function branchUser(fullName: string | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return clipSlug(slugify(first), 20);
}

export interface BranchNameOptions {
  /** Handle for the `user/` prefix (already a slug, or a first name; it is slugified anyway). */
  user?: string;
  /** Issue or workstream key: "BUG-142". */
  key: string;
  title: string;
  format?: BranchFormat;
}

/**
 * `alessandro/bug-142-remove-deprecated-v1-sessions-table` (default), `bug-142-remove-…`, or
 * `feature/bug-142-remove-…`. The title part is cut at a word boundary to ≤ 50 characters and the whole
 * name stays around 70.
 */
export function branchName(opts: BranchNameOptions): string {
  const format = opts.format ?? DEFAULT_BRANCH_FORMAT;
  const key = slugify(opts.key);
  const user = slugify(opts.user ?? '');
  let prefix = '';
  if (format === 'feature/key-title') prefix = 'feature/';
  else if (format === 'user/key-title' && user) prefix = `${user}/`;

  const head = `${prefix}${key}`;
  const budget = Math.max(12, Math.min(BRANCH_TITLE_MAX, BRANCH_TOTAL_MAX - head.length - 1));
  const title = clipSlug(slugify(opts.title), budget);
  return title ? `${head}-${title}` : head;
}
