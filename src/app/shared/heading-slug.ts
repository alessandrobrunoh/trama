// Pure helpers shared by the markdown renderer (heading ids) and the document outline (no Angular here).

/** Heading text as shown: inline markdown syntax removed (`**Plan** for [Q4](url)` → `Plan for Q4`). */
export function plainHeading(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** URL-fragment friendly id: lowercase, accents folded, words joined with `-`. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** Hands out unique slugs in document order: the second "Notes" becomes `notes-1`. */
export class SlugCounter {
  private readonly seen = new Map<string, number>();

  next(text: string): string {
    const base = slugify(text);
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }
}

export interface OutlineItem {
  level: number;
  text: string;
  /** Same id the rendered heading carries. */
  slug: string;
  /** Character offset of the heading line in the source. */
  offset: number;
  /** Zero-based line of the heading. */
  line: number;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Headings of a markdown source, outside fenced code, with the ids the preview gives them. Quoted
 * headings (`> # x`) are left out: they are not part of the page structure.
 */
export function extractOutline(source: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const slugs = new SlugCounter();
  let inFence: string | null = null;
  let offset = 0;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const fence = FENCE.exec(line);
    if (fence) {
      if (!inFence) inFence = fence[1];
      else if (fence[1] === inFence) inFence = null;
    } else if (!inFence) {
      const m = ATX.exec(line);
      if (m) {
        const text = plainHeading(m[2]);
        if (text) out.push({ level: m[1].length, text, slug: slugs.next(text), offset, line: i });
      }
    }
    offset += line.length + 1;
  });
  return out;
}

/** Words of the prose (code fences and markup characters do not count). */
export function wordCount(source: string): number {
  const text = source
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|\-[\]()]+/g, ' ');
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
}

/** Whole minutes at 200 words per minute, at least 1 for any text. */
export function readingMinutes(words: number): number {
  return words <= 0 ? 0 : Math.max(1, Math.round(words / 200));
}
