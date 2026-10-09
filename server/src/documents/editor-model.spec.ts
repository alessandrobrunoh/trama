import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS,
  applyEdit,
  applySlash,
  continueList,
  findSlashTrigger,
  indentLines,
  insertLink,
  matchSlashCommands,
  pasteLinkOverSelection,
  setHeading,
  toggleLinePrefix,
  wrapSelection,
} from '../../../src/app/features/documents/editor-commands.ts';
import {
  htmlToMarkdown,
  shouldConvertHtml,
} from '../../../src/app/features/documents/html-to-markdown.ts';
import {
  diffStats,
  lineDiff,
  merge3,
} from '../../../src/app/features/documents/text-merge.ts';
import {
  extractOutline,
  plainHeading,
  readingMinutes,
  slugify,
  wordCount,
} from '../../../src/app/shared/heading-slug.ts';

describe('outline', () => {
  it('lists headings outside code fences with the ids the preview uses', () => {
    const src =
      '# Title\n\nintro\n\n```md\n# not a heading\n```\n\n## Plan **now**\n### Notes\n## Notes\n> # quoted\n';
    const o = extractOutline(src);
    expect(o.map((h) => [h.level, h.text, h.slug])).toEqual([
      [1, 'Title', 'title'],
      [2, 'Plan now', 'plan-now'],
      [3, 'Notes', 'notes'],
      [2, 'Notes', 'notes-1'],
    ]);
    expect(src.slice(o[1].offset, o[1].offset + 5)).toBe('## Pl');
    expect(o[1].line).toBe(8);
  });

  it('slugifies accents and symbols', () => {
    expect(slugify('Perché è così? (v2)')).toBe('perche-e-cosi-v2');
    expect(slugify('!!!')).toBe('section');
    expect(plainHeading('A [link](http://x.y) and `code` and _em_')).toBe(
      'A link and code and em',
    );
  });

  it('counts words of prose, not code or markup', () => {
    expect(
      wordCount(
        '# Hi there\n\n- one two\n\n```\nlots of code here\n```\n[link text](http://x)',
      ),
    ).toBe(6);
    expect(wordCount('')).toBe(0);
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(30)).toBe(1);
    expect(readingMinutes(1000)).toBe(5);
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings, emphasis, links and paragraphs', () => {
    const md = htmlToMarkdown(
      '<h2>Release <em>plan</em></h2><p>Ship <strong>fast</strong> &amp; safe, see <a href="https://x.test/a?b=1">the doc</a>.</p>',
    );
    expect(md).toBe(
      '## Release *plan*\n\nShip **fast** & safe, see [the doc](https://x.test/a?b=1).',
    );
  });

  it('converts nested lists and checklists', () => {
    const md = htmlToMarkdown(
      '<ul><li>One<ul><li>Nested</li></ul></li><li><input type="checkbox" checked> Done</li></ul><ol start="3"><li>Third</li><li>Fourth</li></ol>',
    );
    expect(md).toBe('- One\n  - Nested\n- [x] Done\n\n3. Third\n4. Fourth');
  });

  it('converts tables, code blocks and quotes', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>a|b</td><td>2</td></tr></tbody></table><pre><code class="language-ts">const a = 1;\nlet b;</code></pre><blockquote><p>Quoted</p></blockquote><hr>',
    );
    expect(md).toBe(
      '| Name | Qty |\n| --- | --- |\n| a\\|b | 2 |\n\n```ts\nconst a = 1;\nlet b;\n```\n\n> Quoted\n\n---',
    );
  });

  it('never lets markup, script or unsafe links through', () => {
    const md = htmlToMarkdown(
      '<p>hi <script>alert(1)</script><a href="javascript:alert(1)">click</a> <img src="data:image/png;base64,AAA" alt="pic"> <a href="//evil.test">x</a> <img src="https://x.test/i.png" alt="ok"></p><style>p{color:red}</style><iframe src="x"></iframe>',
    );
    expect(md).not.toContain('javascript');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('data:');
    expect(md).not.toContain('//evil');
    expect(md).toContain('click');
    expect(md).toContain('![ok](https://x.test/i.png)');
  });

  it('escapes characters that would become markup and keeps Google Docs wrappers neutral', () => {
    expect(htmlToMarkdown('<p>2 * 3 = _six_ and <b>x</b></p>')).toBe(
      '2 \\* 3 = \\_six\\_ and **x**',
    );
    expect(
      htmlToMarkdown(
        '<b style="font-weight:normal" id="docs-internal-guid-1"><p>Plain</p><p><span style="font-weight:700">Bold</span></p></b>',
      ),
    ).toBe('Plain\n\n**Bold**');
  });

  it('handles clipboard fragments with comments, meta tags and entities', () => {
    expect(
      htmlToMarkdown(
        '<meta charset="utf-8"><!--StartFragment--><p>a&nbsp;b &#8364; &#x41;</p><!--EndFragment-->',
      ),
    ).toBe('a b € A');
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('<div></div>')).toBe('');
  });

  it('survives broken and hostile input', () => {
    expect(() =>
      htmlToMarkdown('<<<p>><b><i>unclosed <a href="x"'),
    ).not.toThrow();
    expect(() => htmlToMarkdown('<div>'.repeat(5000))).not.toThrow();
  });
});

describe('shouldConvertHtml', () => {
  it('converts rich content, skips plain wrappers, markdown text and code-editor highlighting', () => {
    expect(shouldConvertHtml('<h1>T</h1><p>x</p>', 'T\nx')).toBe(true);
    expect(shouldConvertHtml('<span>just text</span>', 'just text')).toBe(
      false,
    );
    expect(shouldConvertHtml('<b>x</b>', '# Heading\n- [ ] todo')).toBe(false);
    expect(
      shouldConvertHtml(
        '<div><span style="color:red">const</span> x</div><b>b</b>',
        'const x',
        ['text/plain', 'text/html', 'vscode-editor-data'],
      ),
    ).toBe(false);
    expect(shouldConvertHtml('', 'x')).toBe(false);
  });
});

describe('merge3', () => {
  const base = 'a\nb\nc\nd\ne';

  it('combines changes in different places', () => {
    expect(merge3(base, 'a\nB\nc\nd\ne', 'a\nb\nc\nd\nE')).toEqual({
      text: 'a\nB\nc\nd\nE',
      conflicts: 0,
    });
  });

  it('takes the other side when only one changed, and counts an identical change once', () => {
    expect(merge3(base, base, 'x')).toEqual({ text: 'x', conflicts: 0 });
    expect(merge3(base, 'x', base)).toEqual({ text: 'x', conflicts: 0 });
    expect(merge3(base, 'a\nB\nc\nd\ne', 'a\nB\nc\nd\ne')).toEqual({
      text: 'a\nB\nc\nd\ne',
      conflicts: 0,
    });
    expect(merge3(base, 'a\nB\nc\nd\ne\nf', 'a\nB\nc\nd\ne')).toEqual({
      text: 'a\nB\nc\nd\ne\nf',
      conflicts: 0,
    });
  });

  it('merges insertions and deletions in separate places', () => {
    expect(merge3(base, 'new\na\nb\nc\nd\ne', 'a\nb\nd\ne')).toEqual({
      text: 'new\na\nb\nd\ne',
      conflicts: 0,
    });
    expect(merge3(base, 'a\nb\nc\nd\ne\nend', 'start\na\nb\nc\nd\ne')).toEqual({
      text: 'start\na\nb\nc\nd\ne\nend',
      conflicts: 0,
    });
  });

  it('reports overlapping different edits as a conflict with both sides kept', () => {
    const r = merge3(base, 'a\nmine\nc\nd\ne', 'a\ntheirs\nc\nd\ne');
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(
      'a\n<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> theirs\nc\nd\ne',
    );
  });

  it('treats edit-versus-delete of the same line as a conflict', () => {
    expect(merge3(base, 'a\nB\nc\nd\ne', 'a\nc\nd\ne').conflicts).toBe(1);
  });

  it('keeps every line of a long text edited in two far-apart places', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const mine = long.replace('line 10\n', 'line 10 mine\n');
    const theirs = long.replace('line 390\n', 'line 390 theirs\n');
    const r = merge3(long, mine, theirs);
    expect(r.conflicts).toBe(0);
    expect(r.text).toContain('line 10 mine');
    expect(r.text).toContain('line 390 theirs');
    expect(r.text.split('\n')).toHaveLength(400);
  });
});

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines', () => {
    const ops = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(ops.map((o) => `${o.t}:${o.line}`)).toEqual([
      'eq:a',
      'del:b',
      'add:x',
      'eq:c',
      'add:d',
    ]);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    expect(diffStats(lineDiff(['a'], ['a']))).toEqual({ added: 0, removed: 0 });
  });
});

describe('editor commands', () => {
  const state = (value: string, start = value.length, end = start) => ({
    value,
    start,
    end,
  });
  const run = (
    value: string,
    start: number,
    end: number,
    edit: ReturnType<typeof wrapSelection> | null,
  ) => (edit ? applyEdit(value, edit) : value);

  it('wraps and unwraps a selection', () => {
    const v = 'make this bold';
    const wrapped = wrapSelection(state(v, 5, 9), '**');
    expect(applyEdit(v, wrapped)).toBe('make **this** bold');
    expect(wrapped.selStart).toBe(7);
    const v2 = 'make **this** bold';
    expect(applyEdit(v2, wrapSelection(state(v2, 7, 11), '**'))).toBe(
      'make this bold',
    );
    expect(applyEdit('', wrapSelection(state(''), '**', '**', 'bold'))).toBe(
      '**bold**',
    );
  });

  it('inserts links, and turns a pasted address over a selection into a link', () => {
    expect(applyEdit('see docs', insertLink(state('see docs', 4, 8)))).toBe(
      'see [docs](url)',
    );
    const v = 'read the spec';
    expect(
      run(
        v,
        9,
        13,
        pasteLinkOverSelection(state(v, 9, 13), ' https://x.test/spec '),
      ),
    ).toBe('read the [spec](https://x.test/spec)');
    expect(pasteLinkOverSelection(state(v, 9, 9), 'https://x.test')).toBeNull();
    expect(pasteLinkOverSelection(state(v, 9, 13), 'not a url')).toBeNull();
  });

  it('continues lists, numbers and checklists on Enter, and leaves the list on an empty item', () => {
    expect(applyEdit('- one', continueList(state('- one'))!)).toBe('- one\n- ');
    expect(applyEdit('  1. one', continueList(state('  1. one'))!)).toBe(
      '  1. one\n  2. ',
    );
    expect(applyEdit('- [x] done', continueList(state('- [x] done'))!)).toBe(
      '- [x] done\n- [ ] ',
    );
    expect(applyEdit('> quote', continueList(state('> quote'))!)).toBe(
      '> quote\n> ',
    );
    expect(applyEdit('- one\n- ', continueList(state('- one\n- '))!)).toBe(
      '- one\n',
    );
    expect(continueList(state('plain'))).toBeNull();
    expect(continueList(state('- one', 1, 3))).toBeNull();
  });

  it('splits the item at the caret when Enter is pressed mid-line', () => {
    const v = '- onetwo';
    expect(applyEdit(v, continueList(state(v, 5))!)).toBe('- one\n- two');
  });

  it('indents and outdents the selected lines', () => {
    const v = '- a\n- b';
    expect(applyEdit(v, indentLines(state(v, 0, v.length), false)!)).toBe(
      '  - a\n  - b',
    );
    expect(applyEdit('  - a', indentLines(state('  - a', 5), true)!)).toBe(
      '- a',
    );
    expect(indentLines(state('', 0), false)).not.toBeNull();
  });

  it('toggles list, quote and heading prefixes', () => {
    const v = 'one\ntwo';
    expect(applyEdit(v, toggleLinePrefix(state(v, 0, v.length), '- '))).toBe(
      '- one\n- two',
    );
    expect(
      applyEdit(
        '- one\n- two',
        toggleLinePrefix(state('- one\n- two', 0, 11), '- '),
      ),
    ).toBe('one\ntwo');
    expect(
      applyEdit(v, toggleLinePrefix(state(v, 0, v.length), '1. ', true)),
    ).toBe('1. one\n2. two');
    expect(applyEdit('text', setHeading(state('text'), 2))).toBe('## text');
    expect(applyEdit('## text', setHeading(state('## text'), 2))).toBe('text');
    expect(applyEdit('# text', setHeading(state('# text'), 3))).toBe(
      '### text',
    );
  });

  it('opens the slash menu for / at the start of a line or after a space, not inside words or urls', () => {
    expect(findSlashTrigger('/', 1)).toMatchObject({
      query: '',
      start: 0,
      atLineStart: true,
    });
    expect(findSlashTrigger('intro\n  /hea', 12)).toMatchObject({
      query: 'hea',
      start: 8,
      atLineStart: true,
    });
    expect(findSlashTrigger('see /da', 7)).toMatchObject({
      query: 'da',
      start: 4,
      atLineStart: false,
    });
    expect(findSlashTrigger('https://x.test', 14)).toBeNull();
    expect(findSlashTrigger('a/b', 3)).toBeNull();
  });

  it('filters commands by query and keeps blocks to line starts', () => {
    const line = findSlashTrigger('/che', 4)!;
    expect(matchSlashCommands(line).map((c) => c.id)).toEqual(['todo']);
    const inline = findSlashTrigger('word /', 6)!;
    expect(matchSlashCommands(inline).map((c) => c.id)).toEqual([
      'link',
      'mention',
      'date',
    ]);
    expect(matchSlashCommands(findSlashTrigger('/zzz', 4)!)).toEqual([]);
    expect(SLASH_COMMANDS.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'h1',
        'h2',
        'h3',
        'bullet',
        'numbered',
        'todo',
        'quote',
        'code',
        'table',
      ]),
    );
  });

  it('applies a slash command in place of the typed text', () => {
    const v = 'intro\n/code';
    const t = findSlashTrigger(v, v.length)!;
    const cmd = SLASH_COMMANDS.find((c) => c.id === 'code')!;
    const e = applySlash(state(v), t, cmd, '2026-10-09');
    expect(applyEdit(v, e)).toBe('intro\n```\n\n```');
    expect(e.selStart).toBe(6 + 4);
    const d = SLASH_COMMANDS.find((c) => c.id === 'date')!;
    expect(
      applyEdit(
        'on /dat',
        applySlash(
          state('on /dat'),
          findSlashTrigger('on /dat', 7)!,
          d,
          '2026-10-09',
        ),
      ),
    ).toBe('on 2026-10-09');
  });
});
