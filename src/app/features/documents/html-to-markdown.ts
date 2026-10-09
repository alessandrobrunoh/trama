// Pasted HTML → Markdown. A small tokenizer + tree walker, no DOM: the HTML is never inserted into the page
// and nothing in it can run. Only text, structure and http(s)/mailto/relative links survive.

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | string;

const VOID = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'col',
  'wbr',
  'source',
  'area',
  'base',
  'embed',
  'param',
  'track',
]);
const SKIP = new Set([
  'script',
  'style',
  'head',
  'title',
  'noscript',
  'template',
  'iframe',
  'object',
  'svg',
  'canvas',
  'select',
  'button',
  'textarea',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'figure',
  'figcaption',
  'details',
  'summary',
  'address',
  'form',
  'fieldset',
  'center',
  'dl',
  'dt',
  'dd',
  'body',
  'html',
]);
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  euro: '€',
};
const MAX_DEPTH = 60;
const MAX_INPUT = 2_000_000;

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|[^<]+|</g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(ATTR))
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function parse(html: string): Node[] {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  let skipUntil: string | null = null;
  for (const m of html.matchAll(TOKEN)) {
    const [raw, closing, opening, attrSrc, selfClose] = m;
    if (skipUntil) {
      if (closing?.toLowerCase() === skipUntil) skipUntil = null;
      continue;
    }
    const top = stack[stack.length - 1];
    if (closing) {
      const tag = closing.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (opening) {
      const tag = opening.toLowerCase();
      if (SKIP.has(tag)) {
        if (!selfClose && !VOID.has(tag)) skipUntil = tag;
        continue;
      }
      // an <li> or <p> closes the previous sibling of the same kind
      if ((tag === 'li' || tag === 'p') && top.tag === tag && stack.length > 1) stack.pop();
      const el: El = { tag, attrs: parseAttrs(attrSrc ?? ''), children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClose && !VOID.has(tag) && stack.length < MAX_DEPTH) stack.push(el);
    } else if (!raw.startsWith('<')) {
      top.children.push(decodeEntities(raw));
    }
  }
  return root.children;
}

// ───────────── conversion ─────────────

const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

function isEl(n: Node): n is El {
  return typeof n !== 'string';
}

function hasBlock(el: El): boolean {
  return el.children.some(
    (c) =>
      isEl(c) &&
      (BLOCK.has(c.tag) ||
        /^(h[1-6]|ul|ol|li|table|blockquote|pre|hr)$/.test(c.tag) ||
        hasBlock(c)),
  );
}

function textOf(nodes: Node[]): string {
  return nodes.map((n) => (isEl(n) ? (n.tag === 'br' ? '\n' : textOf(n.children)) : n)).join('');
}

/** Whitespace as HTML renders it: runs collapse to one space. */
const collapse = (s: string) => s.replace(/[\t\n\r\f ]+/g, ' ');

/** Characters that would turn plain text into markup. */
function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, '$1\\$2$3');
}

function wrap(mark: string, content: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : content;
}

const styleOf = (el: El) => (el.attrs['style'] ?? '').toLowerCase();
const isBoldStyle = (s: string) => /font-weight:\s*(bold|[6-9]00)/.test(s);
const isNormalWeight = (s: string) => /font-weight:\s*(normal|[1-5]00)/.test(s);
const isItalicStyle = (s: string) => /font-style:\s*italic/.test(s);
const isStrikeStyle = (s: string) => /text-decoration[^;]*line-through/.test(s);

function inline(nodes: Node[]): string {
  let out = '';
  for (const n of nodes) {
    if (!isEl(n)) {
      out += escapeText(collapse(n));
      continue;
    }
    const style = styleOf(n);
    switch (n.tag) {
      case 'br':
        out += '  \n';
        break;
      case 'code':
      case 'kbd':
      case 'samp': {
        const t = textOf(n.children).replace(/\s+/g, ' ');
        const fence = t.includes('`') ? '``' : '`';
        out += t.trim() ? `${fence}${t.trim()}${fence}` : '';
        break;
      }
      case 'strong':
      case 'b':
        out += isNormalWeight(style) ? inline(n.children) : wrap('**', inline(n.children));
        break;
      case 'em':
      case 'i':
      case 'cite':
        out += wrap('*', inline(n.children));
        break;
      case 'del':
      case 's':
      case 'strike':
        out += wrap('~~', inline(n.children));
        break;
      case 'a': {
        const href = (n.attrs['href'] ?? '').trim();
        const label = inline(n.children).trim();
        if (!label) break;
        out += SAFE_URL.test(href)
          ? `[${label.replace(/\n/g, ' ')}](${href.replace(/[()\s]/g, encodeURIComponent)})`
          : label;
        break;
      }
      case 'img': {
        const src = (n.attrs['src'] ?? '').trim();
        const alt = (n.attrs['alt'] ?? '').replace(/[\]\n]/g, ' ').trim();
        if (/^https?:\/\//i.test(src))
          out += `![${alt}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
        else if (alt) out += escapeText(alt);
        break;
      }
      case 'input':
        break;
      default: {
        let t = inline(n.children);
        if (isBoldStyle(style)) t = wrap('**', t);
        if (isItalicStyle(style)) t = wrap('*', t);
        if (isStrikeStyle(style)) t = wrap('~~', t);
        out += t;
      }
    }
  }
  return out;
}

/** Trims a run of text, keeping a trailing two-space hard break inside it. */
const tidy = (s: string) =>
  s
    .replace(/[ \t]+\n/g, (m) => (m.length >= 3 ? '  \n' : '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split('\n')
    .map((l, i) => (l ? (i === 0 ? first : prefix) + l : l))
    .join('\n');
}

function listItems(el: El): El[] {
  return el.children.filter((c): c is El => isEl(c) && c.tag === 'li');
}

function list(el: El): string {
  const ordered = el.tag === 'ol';
  let n = parseInt(el.attrs['start'] ?? '1', 10) || 1;
  const lines: string[] = [];
  for (const li of listItems(el)) {
    let task = '';
    const kids = li.children.filter((c) => {
      if (isEl(c) && c.tag === 'input' && (c.attrs['type'] ?? '') === 'checkbox') {
        task = 'checked' in c.attrs ? '[x] ' : '[ ] ';
        return false;
      }
      return true;
    });
    const blocks = flow(kids);
    const marker = ordered ? `${n++}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    if (!blocks.length) {
      lines.push(marker.trimEnd());
      continue;
    }
    const [head, ...rest] = blocks;
    const nestedFirst = /^( {0,3})([-*+]|\d+[.)])\s/.test(head);
    const item = nestedFirst
      ? [marker.trimEnd(), indent(head, pad)]
      : [indent(head, pad, marker + task)];
    for (const r of rest) item.push(indent(r, pad));
    lines.push(item.join('\n'));
  }
  return lines.join('\n');
}

function tableMd(el: El): string {
  const rows: El[] = [];
  const collect = (nodes: Node[]) => {
    for (const c of nodes) {
      if (!isEl(c)) continue;
      if (c.tag === 'tr') rows.push(c);
      else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collect(c.children);
    }
  };
  collect(el.children);
  const cells = rows.map((r) =>
    r.children
      .filter((c): c is El => isEl(c) && (c.tag === 'td' || c.tag === 'th'))
      .map((c) =>
        tidy(inline(c.children))
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\|/g, '\\|'),
      ),
  );
  const width = Math.max(0, ...cells.map((r) => r.length));
  if (!width || !cells.length) return '';
  const row = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] || ' ').join(' | ')} |`;
  const [head, ...body] = cells;
  return [
    row(head),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(row),
  ].join('\n');
}

/** Children as markdown blocks, in order. Inline runs between blocks become paragraphs. */
function flow(nodes: Node[]): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const t = tidy(inline(run));
    if (t) out.push(t);
    run = [];
  };
  for (const n of nodes) {
    if (!isEl(n)) {
      run.push(n);
      continue;
    }
    const heading = /^h([1-6])$/.exec(n.tag);
    if (heading) {
      flush();
      const t = tidy(inline(n.children)).replace(/\s*\n\s*/g, ' ');
      if (t) out.push(`${'#'.repeat(Number(heading[1]))} ${t}`);
    } else if (n.tag === 'ul' || n.tag === 'ol') {
      flush();
      const l = list(n);
      if (l) out.push(l);
    } else if (n.tag === 'blockquote') {
      flush();
      const inner = flow(n.children).join('\n\n');
      if (inner)
        out.push(
          inner
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'),
        );
    } else if (n.tag === 'pre') {
      flush();
      const code = n.children.find((c): c is El => isEl(c) && c.tag === 'code');
      const lang =
        /(?:language|lang)-([\w+-]+)/.exec(code?.attrs['class'] ?? n.attrs['class'] ?? '')?.[1] ??
        '';
      const text = textOf(code ? code.children : n.children).replace(/\n+$/, '');
      const fence = text.includes('```') ? '~~~' : '```';
      if (text.trim()) out.push(`${fence}${lang}\n${text}\n${fence}`);
    } else if (n.tag === 'table') {
      flush();
      const t = tableMd(n);
      if (t) out.push(t);
    } else if (n.tag === 'hr') {
      flush();
      out.push('---');
    } else if (n.tag === 'li') {
      // a stray <li> outside a list
      flush();
      out.push(...flow(n.children).map((b) => `- ${b}`));
    } else if (BLOCK.has(n.tag) || (hasBlock(n) && !['a', 'code'].includes(n.tag))) {
      flush();
      out.push(...flow(n.children));
    } else {
      run.push(n);
    }
  }
  flush();
  return out;
}

/** Markdown for a pasted HTML fragment. Empty when nothing readable is left. */
export function htmlToMarkdown(html: string): string {
  if (!html || html.length > MAX_INPUT) return '';
  const md = flow(parse(html)).join('\n\n');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

const STRUCTURE =
  /<(h[1-6]|ul|ol|li|table|blockquote|pre|a\s|strong|b[\s>]|em[\s>]|i[\s>]|code|del|s[\s>]|hr|img)\b/i;
const MARKDOWN_LINE = /^(\s{0,3}#{1,6}\s+\S|\s*```|\s*[-*+]\s+\[[ xX]\]\s|\s*>\s+\S|\|.+\|\s*$)/m;

/**
 * Should a paste of this clipboard be converted from HTML? Yes when the HTML carries structure the plain text
 * lost (headings, lists, tables, links…). No when the plain text already is markdown, or when the HTML is only
 * syntax highlighting from a code editor.
 */
export function shouldConvertHtml(
  html: string,
  plain: string,
  types: readonly string[] = [],
): boolean {
  if (!html || html.length > MAX_INPUT) return false;
  if (types.some((t) => t.startsWith('vscode-'))) return false;
  if (!STRUCTURE.test(html)) return false;
  if (MARKDOWN_LINE.test(plain)) return false;
  return htmlToMarkdown(html).length > 0;
}
