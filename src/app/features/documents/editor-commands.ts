// Text edits behind the document editor's toolbar, shortcuts and slash menu. Pure functions over
// (text, selection) that return an `Edit`; the component applies it to the textarea.

export interface EditState {
  value: string;
  /** Selection start / end (caret when equal). */
  start: number;
  end: number;
}

/** Replace `value[from, to)` with `insert`, then select `[selStart, selEnd)`. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

export function applyEdit(value: string, e: Edit): string {
  return value.slice(0, e.from) + e.insert + value.slice(e.to);
}

const lineStart = (value: string, pos: number) => value.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (value: string, pos: number) => {
  const i = value.indexOf('\n', pos);
  return i < 0 ? value.length : i;
};

/** `**bold**` around the selection; selecting already-wrapped text (or the marks around it) removes them. */
export function wrapSelection(
  s: EditState,
  before: string,
  after = before,
  placeholder = '',
): Edit {
  const { value, start, end } = s;
  const selected = value.slice(start, end);
  if (
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    selected.length >= before.length + after.length
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  if (
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    return {
      from: start - before.length,
      to: end + after.length,
      insert: selected,
      selStart: start - before.length,
      selEnd: start - before.length + selected.length,
    };
  }
  const text = selected || placeholder;
  return {
    from: start,
    to: end,
    insert: before + text + after,
    selStart: start + before.length,
    selEnd: start + before.length + text.length,
  };
}

/** `[text](url)` around the selection, with the url part selected for typing. */
export function insertLink(s: EditState, url = ''): Edit {
  const text = s.value.slice(s.start, s.end);
  if (url) {
    const label = text || url;
    return {
      from: s.start,
      to: s.end,
      insert: `[${label}](${url})`,
      selStart: s.start + label.length + 3 + url.length + 1,
      selEnd: s.start + label.length + 3 + url.length + 1,
    };
  }
  const label = text || 'link';
  const urlStart = s.start + label.length + 3;
  return {
    from: s.start,
    to: s.end,
    insert: `[${label}](url)`,
    selStart: urlStart,
    selEnd: urlStart + 3,
  };
}

/** Pasting a web address over selected text makes the selection a link. */
export function pasteLinkOverSelection(s: EditState, pasted: string): Edit | null {
  const url = pasted.trim();
  if (
    s.start === s.end ||
    !/^https?:\/\/\S+$/i.test(url) ||
    s.value.slice(s.start, s.end).includes('\n')
  )
    return null;
  return insertLink(s, url);
}

const LIST_LINE = /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?/;
const QUOTE_LINE = /^(\s*(?:>\s?)+)/;

/**
 * Enter inside a list or quote continues it: `- a⏎` → `- a\n- `, checklists start unchecked, numbers count up.
 * Enter on an empty item removes the marker instead. `null` = let the browser handle Enter.
 */
export function continueList(s: EditState): Edit | null {
  if (s.start !== s.end) return null;
  const { value, start } = s;
  const ls = lineStart(value, start);
  const before = value.slice(ls, start);
  const after = value.slice(start, lineEnd(value, start));
  const list = LIST_LINE.exec(before);
  if (list) {
    const [whole, indent, marker, task] = list;
    if (before.length === whole.length && !after.trim()) {
      // empty item: leave the list
      return {
        from: ls,
        to: start + after.length,
        insert: indent,
        selStart: ls + indent.length,
        selEnd: ls + indent.length,
      };
    }
    const num = /^(\d+)([.)])/.exec(marker.trim());
    const next = num ? `${Number(num[1]) + 1}${num[2]} ` : marker;
    const insert = `\n${indent}${next}${task ? '[ ] ' : ''}`;
    return {
      from: start,
      to: start,
      insert,
      selStart: start + insert.length,
      selEnd: start + insert.length,
    };
  }
  const quote = QUOTE_LINE.exec(before);
  if (quote) {
    if (before.length === quote[0].length && !after.trim())
      return { from: ls, to: start + after.length, insert: '', selStart: ls, selEnd: ls };
    const insert = `\n${quote[1]}`;
    return {
      from: start,
      to: start,
      insert,
      selStart: start + insert.length,
      selEnd: start + insert.length,
    };
  }
  return null;
}

/** Tab / Shift+Tab: indent or outdent the lines of the selection by two spaces (lists nest). */
export function indentLines(s: EditState, outdent: boolean): Edit | null {
  const { value, start, end } = s;
  const from = lineStart(value, start);
  const to = lineEnd(value, end > start && value[end - 1] === '\n' ? end - 1 : end);
  const block = value.slice(from, to);
  const lines = block.split('\n');
  let first = 0;
  let total = 0;
  const changed = lines.map((l, i) => {
    let out = l;
    let delta = 0;
    if (outdent) {
      const m = /^( {1,2}|\t)/.exec(l);
      if (m) {
        out = l.slice(m[0].length);
        delta = -m[0].length;
      }
    } else if (l.length || lines.length === 1) {
      out = `  ${l}`;
      delta = 2;
    }
    if (i === 0) first = delta;
    total += delta;
    return out;
  });
  if (!total)
    return outdent
      ? { from: start, to: end, insert: value.slice(start, end), selStart: start, selEnd: end }
      : null;
  return {
    from,
    to,
    insert: changed.join('\n'),
    selStart: Math.max(from, start + first),
    selEnd: Math.max(from, end + total),
  };
}

/** Turns every selected line into `prefix` + text (or removes it when all already have it). */
export function toggleLinePrefix(s: EditState, prefix: string, numbered = false): Edit {
  const { value, start, end } = s;
  const from = lineStart(value, start);
  const to = lineEnd(value, end);
  const lines = value.slice(from, to).split('\n');
  const has = (l: string) => (numbered ? /^\d+[.)]\s/.test(l) : l.startsWith(prefix));
  const strip = (l: string) => (numbered ? l.replace(/^\d+[.)]\s/, '') : l.slice(prefix.length));
  const allHave = lines.every((l) => !l.trim() || has(l));
  let n = 0;
  const out = lines.map((l) => {
    if (allHave) return l.trim() ? strip(l) : l;
    if (!l.trim() && lines.length > 1) return l;
    const clean = LIST_LINE.test(l) && prefix !== '> ' ? l.replace(LIST_LINE, '$1') : l;
    n++;
    return (numbered ? `${n}. ` : prefix) + clean.replace(/^#{1,6}\s+/, '');
  });
  const insert = out.join('\n');
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

/** `# `, `## `, `### ` at the start of the caret's line (same level again removes it). */
export function setHeading(s: EditState, level: 1 | 2 | 3): Edit {
  const { value, start } = s;
  const from = lineStart(value, start);
  const to = lineEnd(value, start);
  const line = value.slice(from, to);
  const mark = '#'.repeat(level) + ' ';
  const bare = line.replace(/^#{1,6}\s+/, '');
  const insert = line.startsWith(mark) ? bare : mark + bare;
  const caret = from + insert.length;
  return { from, to, insert, selStart: caret, selEnd: caret };
}

export function tableTemplate(columns = 3, rows = 2): string {
  const head = `| ${Array.from({ length: columns }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
  const sep = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  const row = `| ${Array.from({ length: columns }, () => ' ').join(' | ')} |`;
  return [head, sep, ...Array.from({ length: rows }, () => row)].join('\n');
}

// ───────────── slash menu ─────────────

export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  /** Text that replaces `/query`, and where the caret goes inside it (offset from its start; default end). */
  insert: (ctx: { today: string }) => { text: string; caret?: number; select?: number };
  /** Needs the start of an empty line (blocks); inline commands also work after a space. */
  block: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'h1',
    label: 'Heading 1',
    hint: '#',
    keywords: 'title header h1',
    block: true,
    insert: () => ({ text: '# ' }),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: '##',
    keywords: 'subtitle header h2',
    block: true,
    insert: () => ({ text: '## ' }),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: '###',
    keywords: 'header h3',
    block: true,
    insert: () => ({ text: '### ' }),
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    hint: '-',
    keywords: 'ul unordered list',
    block: true,
    insert: () => ({ text: '- ' }),
  },
  {
    id: 'numbered',
    label: 'Numbered list',
    hint: '1.',
    keywords: 'ol ordered list',
    block: true,
    insert: () => ({ text: '1. ' }),
  },
  {
    id: 'todo',
    label: 'Checklist',
    hint: '[ ]',
    keywords: 'todo task checkbox',
    block: true,
    insert: () => ({ text: '- [ ] ' }),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: '>',
    keywords: 'blockquote callout',
    block: true,
    insert: () => ({ text: '> ' }),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: '```',
    keywords: 'fence snippet pre',
    block: true,
    insert: () => ({ text: '```\n\n```', caret: 4 }),
  },
  {
    id: 'table',
    label: 'Table',
    hint: '| |',
    keywords: 'grid columns rows',
    block: true,
    insert: () => ({ text: tableTemplate(), caret: 2, select: 8 }),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: '---',
    keywords: 'hr rule line separator',
    block: true,
    insert: () => ({ text: '---\n' }),
  },
  {
    id: 'link',
    label: 'Link',
    hint: '[]()',
    keywords: 'url href',
    block: false,
    insert: () => ({ text: '[link](url)', caret: 7, select: 3 }),
  },
  {
    id: 'mention',
    label: 'Mention a person or record',
    hint: '@',
    keywords: 'at user issue workstream people',
    block: false,
    insert: () => ({ text: '@' }),
  },
  {
    id: 'date',
    label: 'Today’s date',
    hint: 'date',
    keywords: 'today now time',
    block: false,
    insert: ({ today }) => ({ text: today }),
  },
];

export interface SlashTrigger {
  query: string;
  /** Index of the `/`. */
  start: number;
  /** The `/` opens a line (after indentation only). */
  atLineStart: boolean;
}

/** A `/` typed at the start of a line or after a space, with the word typed after it. */
export function findSlashTrigger(value: string, caret: number): SlashTrigger | null {
  const ls = lineStart(value, caret);
  const upto = value.slice(ls, caret);
  const m = /(^|\s)\/([\w-]*)$/.exec(upto);
  if (!m) return null;
  const start = ls + upto.length - m[2].length - 1;
  return { query: m[2], start, atLineStart: !upto.slice(0, upto.length - m[2].length - 1).trim() };
}

export function matchSlashCommands(
  trigger: SlashTrigger,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = trigger.query.toLowerCase();
  return commands
    .filter(
      (c) =>
        (trigger.atLineStart || !c.block) &&
        (!q || `${c.id} ${c.label} ${c.keywords}`.toLowerCase().includes(q)),
    )
    .sort((a, b) => Number(!a.id.startsWith(q)) - Number(!b.id.startsWith(q)));
}

export function applySlash(
  s: EditState,
  trigger: SlashTrigger,
  cmd: SlashCommand,
  today: string,
): Edit {
  const r = cmd.insert({ today });
  const at = trigger.start + (r.caret ?? r.text.length);
  return {
    from: trigger.start,
    to: s.start,
    insert: r.text,
    selStart: at,
    selEnd: at + (r.select ?? 0),
  };
}
