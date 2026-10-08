import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { EntityRefChip, EntityRow } from './entity-ref';
import { PriorityIcon } from './priority-icon';
import { STATUS_VISUALS, StatusLabel } from './status';

/* ───────────── tiny, safe markdown → AST → Angular template (no innerHTML) ───────────── */

type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  /** A mention of a workspace record (key or project name) found by the optional `TextLinker`. */
  | { t: 'ref'; v: string };

/** Splits plain text into text and `ref` nodes; supplied by the host so this file stays data-agnostic. */
export type TextLinker = (text: string) => ({ t: 'text'; v: string } | { t: 'ref'; v: string })[];

interface ListItem {
  checked?: boolean;
  inline: Inline[];
  children: Block[];
}

type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { t: 'p'; inline: Inline[] }
  | {
      t: 'ul';
      items: ListItem[];
      /** Every item starts with a record mention: shown as a card of rows. */ entities?: boolean;
    }
  | { t: 'ol'; items: ListItem[]; entities?: boolean }
  | { t: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'hr' };

type Align = 'left' | 'center' | 'right';

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

/** Parse inline markup: `code`, **bold**, *em* / _em_, ~~del~~, [text](url), bare URLs. */
export function parseInline(src: string, link?: TextLinker): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) out.push(...(link ? link(buf) : [{ t: 'text' as const, v: buf }]));
    buf = '';
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: 'code', v: m[1] });
      i += m[0].length;
    } else if ((m = rest.match(/^\*\*(.+?)\*\*/)) || (m = rest.match(/^__(.+?)__/))) {
      flush();
      out.push({ t: 'strong', c: parseInline(m[1], link) });
      i += m[0].length;
    } else if ((m = rest.match(/^~~(.+?)~~/))) {
      flush();
      out.push({ t: 'del', c: parseInline(m[1], link) });
      i += m[0].length;
    } else if (
      (m = rest.match(/^\*([^*\s][^*]*?)\*/)) ||
      (m = rest.match(/^_([^_\s][^_]*?)_(?!\w)/))
    ) {
      flush();
      out.push({ t: 'em', c: parseInline(m[1], link) });
      i += m[0].length;
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      if (SAFE_HREF.test(m[2])) out.push({ t: 'link', href: m[2], c: parseInline(m[1], link) });
      else out.push({ t: 'text', v: m[1] });
      i += m[0].length;
    } else if ((m = rest.match(/^https?:\/\/[^\s<)]+/)) && (buf === '' || /\s$/.test(buf))) {
      flush();
      out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
      i += m[0].length;
    } else {
      buf += src[i];
      i++;
    }
  }
  flush();
  return out;
}

/** The record mentioned first in a list item (`**BUG-1** – …`, `BUG-1: …`), if any. */
export function leadingRef(nodes: Inline[]): string | null {
  const first = nodes[0];
  if (!first) return null;
  if (first.t === 'ref') return first.v;
  return first.t === 'strong' || first.t === 'em' ? leadingRef(first.c) : null;
}

/** What follows the leading mention, minus the separator (`–`, `:`, `-`) — the model's commentary. */
export function trailing(nodes: Inline[]): Inline[] {
  const rest = nodes.slice(1);
  const head = rest[0];
  if (head?.t === 'text') {
    const v = head.v.replace(/^[\s–—:·|-]+/, '');
    return v ? [{ t: 'text', v }, ...rest.slice(1)] : rest.slice(1);
  }
  return rest;
}

/** Plain text of inline nodes (for comparisons). */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' || n.t === 'ref' ? n.v : plainText(n.c)))
    .join('');
}

/** `| a | b |` → ['a', 'b'] (escaped pipes stay inside the cell). */
function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** A GFM table starts with a header row containing a pipe, followed by a `---|---` separator row. */
function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i].includes('|') &&
    SEPARATOR_RE.test(lines[i + 1]) &&
    lines[i + 1].includes('-')
  );
}

function cellAlign(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : 'left';
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Parse block structure. Exported for tests / reuse. */
export function parseMarkdown(src: string, link?: TextLinker): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines, link);
}

function parseBlocks(lines: string[], link?: TextLinker): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    let m = line.match(/^```\s*([\w+-]*)\s*$/);
    if (m) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ t: 'code', lang: m[1], v: body.join('\n') });
      continue;
    }
    // heading
    m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      blocks.push({
        t: 'heading',
        level: Math.min(m[1].length, 4) as 1 | 2 | 3 | 4,
        inline: parseInline(m[2], link),
      });
      i++;
      continue;
    }
    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    // quote
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', blocks: parseBlocks(q, link) });
      continue;
    }
    // table
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i++]);
        rows.push(head.map((_, c) => parseInline(cells[c] ?? '', link)));
      }
      blocks.push({ t: 'table', head: head.map((h) => parseInline(h, link)), align, rows });
      continue;
    }
    // list
    m = line.match(LIST_RE);
    if (m) {
      const ordered = /\d/.test(m[2]);
      const baseIndent = m[1].length;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const lm = lines[i].match(LIST_RE);
        if (!lm || lm[1].length !== baseIndent) break;
        let text = lm[3];
        let checked: boolean | undefined;
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          checked = task[1] !== ' ';
          text = task[2];
        }
        i++;
        const nested: string[] = [];
        while (i < lines.length) {
          const nl = lines[i];
          if (!nl.trim()) break;
          const nm = nl.match(LIST_RE);
          if (nm && nm[1].length > baseIndent)
            nested.push(nl.slice(Math.min(baseIndent + 2, nm[1].length)));
          else if (!nm && /^\s{2,}\S/.test(nl)) text += ' ' + nl.trim();
          else break;
          i++;
        }
        items.push({
          checked,
          inline: parseInline(text, link),
          children: nested.length ? parseBlocks(nested, link) : [],
        });
      }
      const entities =
        !!link &&
        items.length >= 1 &&
        items.every(
          (it) => !it.children.length && it.checked === undefined && leadingRef(it.inline),
        );
      blocks.push({ t: ordered ? 'ol' : 'ul', items, ...(entities ? { entities } : {}) });
      continue;
    }
    // paragraph (until blank line / block start)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i++].trim());
    }
    blocks.push({ t: 'p', inline: parseInline(para.join(' '), link) });
  }
  return blocks;
}

/**
 * Safe markdown renderer — headings, paragraphs, bold/italic/strike, inline + fenced code,
 * links (http/https/mailto/relative only), (task) lists with nesting, quotes, rules.
 * Raw HTML in the source is shown as text; nothing is ever bound through innerHTML.
 *   <app-markdown [source]="ws.objective" />
 */
@Component({
  selector: 'app-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, EntityRefChip, EntityRow, PriorityIcon, StatusLabel],
  host: {
    class: 'block text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 break-words',
  },
  template: `
    <ng-template #inl let-nodes>
      @for (n of nodes; track $index) {
        @switch (n.t) {
          @case ('text') {
            {{ n.v }}
          }
          @case ('code') {
            <code class="bg-muted rounded px-1 py-0.5 font-mono text-[0.92em]">{{ n.v }}</code>
          }
          @case ('ref') {
            <app-entity-ref [token]="n.v" />
          }
          @case ('strong') {
            <strong class="font-semibold"
              ><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.c }"
            /></strong>
          }
          @case ('em') {
            <em><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.c }" /></em>
          }
          @case ('del') {
            <del class="text-muted-foreground"
              ><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.c }"
            /></del>
          }
          @case ('link') {
            <a
              class="text-primary underline underline-offset-2 hover:opacity-80"
              [attr.href]="n.href"
              target="_blank"
              rel="noopener noreferrer nofollow"
              ><ng-container *ngTemplateOutlet="inl; context: { $implicit: n.c }"
            /></a>
          }
        }
      }
    </ng-template>

    <ng-template #blk let-blocks>
      @for (b of blocks; track $index) {
        @switch (b.t) {
          @case ('heading') {
            @switch (b.level) {
              @case (1) {
                <h2 class="mt-5 mb-2 text-lg font-semibold tracking-tight">
                  <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inline }" />
                </h2>
              }
              @case (2) {
                <h3 class="mt-4 mb-1.5 text-base font-semibold tracking-tight">
                  <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inline }" />
                </h3>
              }
              @default {
                <h4 class="mt-3 mb-1 text-sm font-semibold">
                  <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inline }" />
                </h4>
              }
            }
          }
          @case ('p') {
            <p class="my-2">
              <ng-container *ngTemplateOutlet="inl; context: { $implicit: b.inline }" />
            </p>
          }
          @case ('ul') {
            @if (b.entities) {
              <div class="bg-card my-2 divide-y overflow-hidden rounded-lg border">
                @for (it of b.items; track $index) {
                  <app-entity-row [token]="lead(it.inline)!" [trailText]="text(trail(it.inline))">
                    <ng-container
                      *ngTemplateOutlet="inl; context: { $implicit: trail(it.inline) }"
                    />
                  </app-entity-row>
                }
              </div>
            } @else {
              <ul class="my-2 space-y-1 ps-5 [&_ul]:my-1">
                @for (it of b.items; track $index) {
                  <li
                    [class]="
                      it.checked === undefined
                        ? 'list-disc marker:text-muted-foreground'
                        : 'list-none -ms-5 flex items-start gap-2'
                    "
                  >
                    @if (it.checked !== undefined) {
                      <span
                        class="mt-[3px] inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[10px] leading-none"
                        [class]="
                          it.checked
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-input'
                        "
                        aria-hidden="true"
                        >{{ it.checked ? '✓' : '' }}</span
                      >
                    }
                    <span
                      [class.text-muted-foreground]="it.checked"
                      [class.line-through]="it.checked"
                    >
                      <ng-container *ngTemplateOutlet="inl; context: { $implicit: it.inline }" />
                      <ng-container *ngTemplateOutlet="blk; context: { $implicit: it.children }" />
                    </span>
                  </li>
                }
              </ul>
            }
          }
          @case ('ol') {
            @if (b.entities) {
              <div class="bg-card my-2 divide-y overflow-hidden rounded-lg border">
                @for (it of b.items; track $index) {
                  <app-entity-row [token]="lead(it.inline)!" [trailText]="text(trail(it.inline))">
                    <ng-container
                      *ngTemplateOutlet="inl; context: { $implicit: trail(it.inline) }"
                    />
                  </app-entity-row>
                }
              </div>
            } @else {
              <ol class="my-2 list-decimal space-y-1 ps-5 marker:text-muted-foreground">
                @for (it of b.items; track $index) {
                  <li>
                    <ng-container *ngTemplateOutlet="inl; context: { $implicit: it.inline }" />
                    <ng-container *ngTemplateOutlet="blk; context: { $implicit: it.children }" />
                  </li>
                }
              </ol>
            }
          }
          @case ('table') {
            <div class="bg-card my-3 overflow-x-auto rounded-lg border">
              <table class="w-full border-collapse text-[13px]">
                <thead class="bg-muted/40 text-muted-foreground">
                  <tr>
                    @for (h of b.head; track $index) {
                      <th
                        class="px-3 py-2 font-medium whitespace-nowrap"
                        [style.text-align]="b.align[$index]"
                      >
                        <ng-container *ngTemplateOutlet="inl; context: { $implicit: h }" />
                      </th>
                    }
                  </tr>
                </thead>
                <tbody class="divide-y">
                  @for (row of b.rows; track $index) {
                    <tr class="hover:bg-accent/40 transition-colors">
                      @for (cell of row; track $index) {
                        <td class="px-3 py-2 align-top" [style.text-align]="b.align[$index]">
                          @if (special(cell); as sp) {
                            @if (sp.k === 'priority') {
                              <app-priority-icon [priority]="$any(sp.v)" showLabel />
                            } @else {
                              <app-status-label [status]="$any(sp.v)" />
                            }
                          } @else {
                            <ng-container *ngTemplateOutlet="inl; context: { $implicit: cell }" />
                          }
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @case ('code') {
            <pre
              class="bg-muted my-3 overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs leading-relaxed"
            ><code>{{ b.v }}</code></pre>
          }
          @case ('quote') {
            <blockquote class="text-muted-foreground my-3 border-s-2 ps-3">
              <ng-container *ngTemplateOutlet="blk; context: { $implicit: b.blocks }" />
            </blockquote>
          }
          @case ('hr') {
            <hr class="my-4" />
          }
        }
      }
    </ng-template>

    <ng-container *ngTemplateOutlet="blk; context: { $implicit: blocks() }" />
  `,
})
export class Markdown {
  readonly source = input<string | null | undefined>('');
  /** Turns mentions of workspace records into interactive chips (and lists of them into cards). */
  readonly link = input<TextLinker>();
  protected readonly blocks = computed(() => parseMarkdown(this.source() ?? '', this.link()));
  /** A table cell that is exactly a status or priority word shows the app's own glyph and label. */
  protected special(cell: Inline[]): { k: 'status' | 'priority'; v: string } | null {
    if (cell.length !== 1 || cell[0].t !== 'text') return null;
    const v = cell[0].v.trim().toLowerCase().replace(/\s+/g, '_');
    if (['urgent', 'high', 'medium', 'low'].includes(v)) return { k: 'priority', v };
    return v in STATUS_VISUALS ? { k: 'status', v } : null;
  }
  protected readonly lead = leadingRef;
  protected readonly trail = trailing;
  protected readonly text = plainText;
}
