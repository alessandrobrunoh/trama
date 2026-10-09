import { describe, expect, it } from 'vitest';
import type { ActorRef } from '../contracts/domain.js';
import {
  MARK_END,
  MARK_START,
  buildTsQuery,
  cleanTitle,
  excerptOf,
  isEmoji,
  mergesIntoHead,
  snippetToHtml,
} from './document-rules.js';

describe('buildTsQuery', () => {
  it('makes every word a prefix and keeps only letters and digits', () => {
    expect(buildTsQuery('Spec pla')).toBe('spec:* & pla:*');
    expect(buildTsQuery("o'brien & (drop) | !table")).toBe(
      'o:* & brien:* & drop:* & table:*',
    );
    expect(buildTsQuery('perché città 2026')).toBe(
      'perché:* & città:* & 2026:*',
    );
  });

  it('returns null when there is nothing searchable, and caps the number of terms', () => {
    expect(buildTsQuery('')).toBeNull();
    expect(buildTsQuery(undefined)).toBeNull();
    expect(buildTsQuery(' ?!:* ')).toBeNull();
    expect(buildTsQuery('a b c d e f g h i j')!.split(' & ')).toHaveLength(8);
  });
});

describe('snippetToHtml', () => {
  it('escapes whatever the document held and only adds its own <mark> tags', () => {
    const raw = `see <img src=x onerror=alert(1)> and ${MARK_START}plan${MARK_END} "now" & <script>x</script>`;
    const html = snippetToHtml(raw)!;
    expect(html).toBe(
      'see &lt;img src=x onerror=alert(1)&gt; and <mark>plan</mark> &quot;now&quot; &amp; &lt;script&gt;x&lt;/script&gt;',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  it('is undefined for an empty headline', () => {
    expect(snippetToHtml('')).toBeUndefined();
    expect(snippetToHtml(null)).toBeUndefined();
  });
});

describe('excerptOf', () => {
  it('flattens markdown into a short plain line', () => {
    const md =
      '# Title\n\n- **bold** item with [a link](https://x.test)\n\n```ts\nconst hidden = 1;\n```\n\nAfter';
    expect(excerptOf(md)).toBe('Title bold item with a link After');
    expect(excerptOf('- [x] done\n- [ ] todo')).toBe('done todo');
    expect(excerptOf('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a b 1 2');
  });

  it('truncates with an ellipsis', () => {
    expect(excerptOf('word '.repeat(100), 20)).toMatch(/…$/);
    expect(excerptOf('word '.repeat(100), 20).length).toBeLessThanOrEqual(21);
    expect(excerptOf(null)).toBe('');
  });
});

describe('cleanTitle / mergesIntoHead', () => {
  const me: ActorRef = { type: 'user', id: 'u1' };
  const other: ActorRef = { type: 'user', id: 'u2' };
  const at = new Date('2026-10-09T10:00:00Z');

  it('keeps a title on one line', () => {
    expect(cleanTitle('  a \n\t b  ')).toBe('a b');
  });

  it('merges only the same editor inside the window', () => {
    const head = { editor: me, createdAt: at };
    expect(
      mergesIntoHead(head, me, new Date(at.getTime() + 60_000), 300_000),
    ).toBe(true);
    expect(
      mergesIntoHead(head, me, new Date(at.getTime() + 300_001), 300_000),
    ).toBe(false);
    expect(
      mergesIntoHead(head, other, new Date(at.getTime() + 1000), 300_000),
    ).toBe(false);
    expect(mergesIntoHead(null, me, at)).toBe(false);
  });
});

describe('isEmoji', () => {
  it('accepts one emoji and nothing that could be markup', () => {
    for (const ok of ['📄', '🚀', '👩‍💻', '🇮🇹', '❤️'])
      expect(isEmoji(ok), ok).toBe(true);
    for (const bad of ['', 'a', '<b>', '📄📄', 'doc', '📄 ', '<script>'])
      expect(isEmoji(bad), bad).toBe(false);
  });
});
