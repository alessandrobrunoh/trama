import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
// Every distinct icon adds to the initial bundle (the icon module is shared with the app shell), so the toolbar
// reuses icons the app already ships and draws B / I / S / H / 1. / quote as text.
import {
  LucideCode,
  LucideDynamicIcon,
  LucideLink,
  LucideList,
  LucideListChecks,
  LucideRows3,
  LucideTerminal,
  type LucideIcon,
} from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, Notifier, type ActorRef } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
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
  tableTemplate,
  toggleLinePrefix,
  wrapSelection,
  type Edit,
  type EditState,
  type SlashTrigger,
} from './editor-commands';
import { htmlToMarkdown, shouldConvertHtml } from './html-to-markdown';
import { Documents } from './documents.service';

interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  actor?: ActorRef;
  /** Applies the item in place of the typed trigger. */
  run: () => void;
}

interface Tool {
  id: string;
  label: string;
  keys: string;
  /** An icon, or a short text glyph with its own style. */
  icon?: LucideIcon;
  text?: string;
  textClass?: string;
  run: () => void;
}

/** `@` or `#` at the start of a word, followed by what was typed so far. */
const MENTION = /(^|[\s(])([@#])([^\s@#]*)$/;
const MAX_ITEMS = 8;
const PER_KIND = 4;
const MENU_WIDTH = 288;

/** Style properties copied onto the measuring mirror of the textarea. */
const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'tabSize',
  'wordSpacing',
] as const;

/** Pixel position (inside the textarea box, scroll applied) of the character at `pos`. */
function caretCoords(
  el: HTMLTextAreaElement,
  pos: number,
): { top: number; left: number; height: number } {
  const doc = el.ownerDocument;
  const mirror = doc.createElement('div');
  const cs = getComputedStyle(el);
  for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  mirror.textContent = el.value.slice(0, pos);
  const marker = doc.createElement('span');
  marker.textContent = el.value.slice(pos, pos + 1) || '.';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  const out = {
    top: marker.offsetTop - el.scrollTop,
    left: marker.offsetLeft - el.scrollLeft,
    height: parseFloat(cs.lineHeight) || 20,
  };
  mirror.remove();
  return out;
}

/**
 * Markdown source editor: a plain textarea (fast, accessible, native undo) with a formatting toolbar, keyboard
 * shortcuts, list continuation, a `/` command menu, `@` / `#` mentions and smart paste (HTML becomes Markdown,
 * a link pasted over selected text links it). Bind the text two-way: `<app-document-editor [(value)]="body" />`.
 */
@Component({
  selector: 'app-document-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmTooltip, ActorAvatar],
  host: { class: 'flex min-h-0 min-w-0 flex-1 flex-col' },
  template: `
    @if (!readonly()) {
      <div
        role="toolbar"
        aria-label="Formatting"
        class="scrollbar-none flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 py-1"
      >
        @for (t of tools; track t.id) {
          <button
            type="button"
            class="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
            [attr.aria-label]="t.label"
            [hlmTooltip]="t.label + (t.keys ? ' · ' + t.keys : '')"
            (mousedown)="$event.preventDefault()"
            (click)="t.run()"
          >
            @if (t.icon) {
              <svg [lucideIcon]="t.icon" [size]="15"></svg>
            } @else {
              <span class="text-[13px] leading-none" [class]="t.textClass" aria-hidden="true">{{
                t.text
              }}</span>
            }
          </button>
        }
        @if (hint()) {
          <span class="text-muted-foreground ml-auto hidden shrink-0 pl-3 text-[11px] sm:inline">
            Type <kbd class="bg-muted rounded px-1 font-mono">/</kbd> for commands,
            <kbd class="bg-muted rounded px-1 font-mono">@</kbd> to mention
          </span>
        }
      </div>
    }

    <div class="relative min-h-0 flex-1">
      <textarea
        #field
        class="placeholder:text-muted-foreground/70 absolute inset-0 size-full resize-none bg-transparent px-4 py-4 font-mono text-[13.5px] leading-6 outline-none max-md:pb-28 sm:px-6"
        spellcheck="true"
        autocapitalize="sentences"
        aria-label="Document body (Markdown)"
        role="combobox"
        aria-autocomplete="list"
        [attr.aria-expanded]="menuOpen()"
        [attr.aria-controls]="menuOpen() ? listId : null"
        [attr.aria-activedescendant]="menuOpen() ? listId + '-' + active() : null"
        [readOnly]="readonly()"
        [placeholder]="placeholder()"
        [value]="value()"
        (input)="onInput()"
        (keydown)="onKeydown($event)"
        (keyup)="onCaretMove($event)"
        (click)="refreshMenu()"
        (paste)="onPaste($event)"
        (scroll)="scrolled.emit(ratio())"
        (blur)="onBlur()"
      ></textarea>

      @if (menuOpen()) {
        <ul
          [id]="listId"
          role="listbox"
          [attr.aria-label]="menu()?.kind === 'slash' ? 'Commands' : 'Mentions'"
          class="bg-popover text-popover-foreground absolute z-30 max-h-64 overflow-y-auto rounded-md border p-1 shadow-md"
          [style.width.px]="menuWidth"
          [style.top.px]="menuPos().top"
          [style.left.px]="menuPos().left"
        >
          @for (it of items(); track it.id; let i = $index) {
            <li
              role="option"
              [id]="listId + '-' + i"
              [attr.aria-selected]="i === active()"
              class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm"
              [class]="i === active() ? 'bg-accent text-accent-foreground' : ''"
              (mousedown)="$event.preventDefault(); it.run()"
              (mouseenter)="active.set(i)"
            >
              @if (it.actor) {
                <app-actor-avatar [actor]="it.actor" [size]="16" />
              } @else if (it.hint) {
                <span class="text-muted-foreground w-9 shrink-0 truncate font-mono text-[11px]">{{
                  it.hint
                }}</span>
              }
              <span class="min-w-0 flex-1 truncate">{{ it.label }}</span>
              @if (it.actor && it.hint) {
                <span class="text-muted-foreground text-[11px]">{{ it.hint }}</span>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class DocumentEditor {
  private static nextId = 0;
  private readonly doc = inject(DOCUMENT);
  private readonly store = inject(TramaStore);
  private readonly notifier = inject(Notifier);
  private readonly documents = inject(Documents);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  readonly value = model('');
  readonly readonly = input(false);
  /** Show the "Type / for commands" hint (the page hides it when the editor shares the row with the preview). */
  readonly hint = input(true);
  readonly placeholder = input('Write here, or paste Markdown. Press / for commands.');
  /** Scroll position of the text as 0..1, for syncing the preview. */
  readonly scrolled = output<number>();

  protected readonly listId = `doc-editor-menu-${DocumentEditor.nextId++}`;
  protected readonly menuWidth = MENU_WIDTH;
  protected readonly active = signal(0);
  protected readonly menu = signal<
    | { kind: 'slash'; trigger: SlashTrigger }
    | { kind: 'mention'; char: '@' | '#'; query: string; start: number }
    | null
  >(null);
  protected readonly menuPos = signal({ top: 0, left: 0 });
  private readonly dismissedAt = signal(-1);
  private readonly docHits = signal<{ id: string; title: string }[]>([]);
  private docLookup: ReturnType<typeof setTimeout> | null = null;

  protected readonly tools: Tool[] = [
    {
      id: 'h',
      label: 'Heading',
      keys: '⌘⌥2',
      text: 'H',
      textClass: 'font-semibold',
      run: () => this.edit((s) => setHeading(s, 2)),
    },
    {
      id: 'b',
      label: 'Bold',
      keys: '⌘B',
      text: 'B',
      textClass: 'font-bold',
      run: () => this.edit((s) => wrapSelection(s, '**', '**', 'bold')),
    },
    {
      id: 'i',
      label: 'Italic',
      keys: '⌘I',
      text: 'I',
      textClass: 'italic font-serif',
      run: () => this.edit((s) => wrapSelection(s, '*', '*', 'italic')),
    },
    {
      id: 's',
      label: 'Strikethrough',
      keys: '⌘⇧X',
      text: 'S',
      textClass: 'line-through',
      run: () => this.edit((s) => wrapSelection(s, '~~', '~~', 'text')),
    },
    {
      id: 'c',
      label: 'Inline code',
      keys: '⌘E',
      icon: LucideCode,
      run: () => this.edit((s) => wrapSelection(s, '`', '`', 'code')),
    },
    {
      id: 'l',
      label: 'Link',
      keys: '⌘K',
      icon: LucideLink,
      run: () => this.edit((s) => insertLink(s)),
    },
    {
      id: 'ul',
      label: 'Bulleted list',
      keys: '⌘⇧8',
      icon: LucideList,
      run: () => this.edit((s) => toggleLinePrefix(s, '- ')),
    },
    {
      id: 'ol',
      label: 'Numbered list',
      keys: '⌘⇧7',
      text: '1.',
      textClass: 'font-medium tabular-nums',
      run: () => this.edit((s) => toggleLinePrefix(s, '1. ', true)),
    },
    {
      id: 'todo',
      label: 'Checklist',
      keys: '⌘⇧9',
      icon: LucideListChecks,
      run: () => this.edit((s) => toggleLinePrefix(s, '- [ ] ')),
    },
    {
      id: 'q',
      label: 'Quote',
      keys: '⌘⇧.',
      text: '“',
      textClass: 'font-serif text-lg font-bold',
      run: () => this.edit((s) => toggleLinePrefix(s, '> ')),
    },
    {
      id: 'cb',
      label: 'Code block',
      keys: '',
      icon: LucideTerminal,
      run: () => this.insertBlock('```\n\n```', 4),
    },
    {
      id: 't',
      label: 'Table',
      keys: '',
      icon: LucideRows3,
      run: () => this.insertBlock(tableTemplate(), 2, 8),
    },
  ];

  protected readonly items = computed<MenuItem[]>(() => {
    const m = this.menu();
    if (!m) return [];
    if (m.kind === 'slash') {
      return matchSlashCommands(m.trigger).map((c) => ({
        id: c.id,
        label: c.label,
        hint: c.hint,
        run: () => this.pickSlash(m.trigger, c.id),
      }));
    }
    return this.mentionItems(m.char, m.query, m.start);
  });

  protected readonly menuOpen = computed(() => !!this.menu() && this.items().length > 0);

  constructor() {
    // Documents matching what is typed after @ / # (looked up on the server, debounced).
    effect(() => {
      const m = this.menu();
      const q = m?.kind === 'mention' ? m.query : '';
      untracked(() => {
        if (this.docLookup) clearTimeout(this.docLookup);
        if (!q) return void this.docHits.set([]);
        this.docLookup = setTimeout(() => {
          this.documents
            .list({ q, limit: PER_KIND })
            .then((rows) => this.docHits.set(rows.map((r) => ({ id: r.id, title: r.title }))))
            .catch(() => this.docHits.set([]));
        }, 180);
      });
    });
  }

  // ───────────── public API for the page ─────────────

  focus(): void {
    this.field().nativeElement.focus();
  }

  /** Replaces the whole text (a remote change, a merge, a restored version) keeping the caret where it was. */
  setText(next: string): void {
    const el = this.field().nativeElement;
    const { selectionStart: a, selectionEnd: b } = el;
    const top = el.scrollTop;
    el.value = next;
    this.value.set(next);
    el.setSelectionRange(Math.min(a, next.length), Math.min(b, next.length));
    el.scrollTop = top;
  }

  /** Puts the caret at `offset` and scrolls the text to it. */
  revealOffset(offset: number): void {
    const el = this.field().nativeElement;
    el.focus();
    el.setSelectionRange(offset, offset);
    const { top } = caretCoords(el, offset);
    el.scrollTop = Math.max(0, el.scrollTop + top - 24);
  }

  /** 0..1 position of the text, to set from the preview. */
  scrollToRatio(r: number): void {
    const el = this.field().nativeElement;
    el.scrollTop = r * (el.scrollHeight - el.clientHeight);
  }

  protected ratio(): number {
    const el = this.field().nativeElement;
    const room = el.scrollHeight - el.clientHeight;
    return room > 0 ? el.scrollTop / room : 0;
  }

  // ───────────── editing ─────────────

  private state(): EditState {
    const el = this.field().nativeElement;
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  }

  /**
   * Applies an edit through the browser's own editing command so the change lands on the undo stack
   * (⌘Z works). Falls back to writing the range directly.
   */
  private apply(e: Edit): void {
    const el = this.field().nativeElement;
    const expected = applyEdit(el.value, e);
    el.focus();
    el.setSelectionRange(e.from, e.to);
    let ok = false;
    try {
      ok = e.insert
        ? this.doc.execCommand('insertText', false, e.insert)
        : e.from === e.to || this.doc.execCommand('delete');
    } catch {
      ok = false;
    }
    if (!ok || el.value !== expected) el.value = expected;
    this.value.set(el.value);
    el.setSelectionRange(e.selStart, e.selEnd);
  }

  private edit(make: (s: EditState) => Edit | null): void {
    if (this.readonly()) return;
    const e = make(this.state());
    if (e) this.apply(e);
    this.closeMenu();
  }

  private insertBlock(text: string, caret: number, select = 0): void {
    this.edit((s) => {
      const lineStart = s.value.lastIndexOf('\n', s.start - 1) + 1;
      const lead = s.start > lineStart ? '\n' : '';
      const from = s.start;
      const at = from + lead.length + caret;
      return { from, to: s.end, insert: lead + text, selStart: at, selEnd: at + select };
    });
  }

  protected onInput(): void {
    const el = this.field().nativeElement;
    this.value.set(el.value);
    this.refreshMenu();
  }

  protected onBlur(): void {
    this.closeMenu();
  }

  protected onCaretMove(ev: KeyboardEvent): void {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(ev.key) && this.menuOpen())
      return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace'].includes(ev.key))
      this.refreshMenu();
  }

  protected onKeydown(ev: KeyboardEvent): void {
    if (ev.isComposing || this.readonly()) return;
    if (this.menuOpen()) {
      const n = this.items().length;
      switch (ev.key) {
        case 'ArrowDown':
          ev.preventDefault();
          this.active.update((i) => (i + 1) % n);
          return;
        case 'ArrowUp':
          ev.preventDefault();
          this.active.update((i) => (i - 1 + n) % n);
          return;
        case 'Enter':
        case 'Tab':
          if (ev.shiftKey || ev.metaKey || ev.ctrlKey) break;
          ev.preventDefault();
          this.items()[this.active()]?.run();
          return;
        case 'Escape':
          ev.preventDefault();
          ev.stopPropagation();
          this.dismissedAt.set(this.field().nativeElement.selectionStart);
          this.menu.set(null);
          return;
      }
    }
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key.toLowerCase();
    if (mod && !ev.altKey) {
      if (!ev.shiftKey && key === 'b')
        return this.shortcut(ev, () => this.edit((s) => wrapSelection(s, '**', '**', 'bold')));
      if (!ev.shiftKey && key === 'i')
        return this.shortcut(ev, () => this.edit((s) => wrapSelection(s, '*', '*', 'italic')));
      if (!ev.shiftKey && key === 'e')
        return this.shortcut(ev, () => this.edit((s) => wrapSelection(s, '`', '`', 'code')));
      if (!ev.shiftKey && key === 'k')
        return this.shortcut(ev, () => this.edit((s) => insertLink(s)));
      if (ev.shiftKey && key === 'x')
        return this.shortcut(ev, () => this.edit((s) => wrapSelection(s, '~~', '~~', 'text')));
      if (ev.shiftKey && ev.code === 'Digit7')
        return this.shortcut(ev, () => this.edit((s) => toggleLinePrefix(s, '1. ', true)));
      if (ev.shiftKey && ev.code === 'Digit8')
        return this.shortcut(ev, () => this.edit((s) => toggleLinePrefix(s, '- ')));
      if (ev.shiftKey && ev.code === 'Digit9')
        return this.shortcut(ev, () => this.edit((s) => toggleLinePrefix(s, '- [ ] ')));
      if (ev.shiftKey && ev.code === 'Period')
        return this.shortcut(ev, () => this.edit((s) => toggleLinePrefix(s, '> ')));
    }
    if (mod && ev.altKey && /^Digit[123]$/.test(ev.code)) {
      const level = Number(ev.code.slice(-1)) as 1 | 2 | 3;
      return this.shortcut(ev, () => this.edit((s) => setHeading(s, level)));
    }
    if (ev.key === 'Enter' && !mod && !ev.shiftKey && !ev.altKey) {
      const e = continueList(this.state());
      if (e) {
        ev.preventDefault();
        this.apply(e);
      }
      return;
    }
    if (ev.key === 'Tab' && !mod && !ev.altKey) {
      const s = this.state();
      const line = s.value.slice(s.value.lastIndexOf('\n', s.start - 1) + 1, s.start);
      const inList = /^\s*([-*+]|\d+[.)])\s/.test(line);
      if (inList || s.start !== s.end || ev.shiftKey) {
        const e = indentLines(s, ev.shiftKey);
        if (e) {
          ev.preventDefault();
          this.apply(e);
        } else if (inList) ev.preventDefault();
      }
    }
  }

  private shortcut(ev: KeyboardEvent, run: () => void): void {
    ev.preventDefault();
    run();
  }

  // ───────────── paste ─────────────

  protected onPaste(ev: ClipboardEvent): void {
    if (this.readonly()) return;
    const cd = ev.clipboardData;
    if (!cd) return;
    const plain = cd.getData('text/plain');
    const html = cd.getData('text/html');
    if (!plain && !html && Array.from(cd.files).some((f) => f.type.startsWith('image/'))) {
      ev.preventDefault();
      this.notifier.info('Pasting images is not supported yet', {
        description: 'Link to the image with ![description](https://…) instead.',
      });
      return;
    }
    const state = this.state();
    const link = pasteLinkOverSelection(state, plain);
    if (link) {
      ev.preventDefault();
      this.apply(link);
      return;
    }
    if (html && shouldConvertHtml(html, plain, Array.from(cd.types))) {
      let md = htmlToMarkdown(html);
      if (md) {
        ev.preventDefault();
        const lineStart = state.value.lastIndexOf('\n', state.start - 1) + 1;
        // block markup starts on its own paragraph: a blank line before it when there is text above
        if (/^(#{1,6} |[-*+] |\d+\. |> |\||```)/.test(md)) {
          const above = state.value.slice(0, state.start);
          if (above && !above.endsWith('\n\n'))
            md = (above.endsWith('\n') || state.start === lineStart ? '\n' : '\n\n') + md;
        }
        const at = state.start + md.length;
        this.apply({ from: state.start, to: state.end, insert: md, selStart: at, selEnd: at });
        this.notifier.info('Pasted as Markdown', { duration: 2500 });
      }
    }
  }

  // ───────────── menus ─────────────

  private closeMenu(): void {
    this.menu.set(null);
  }

  protected refreshMenu(): void {
    const el = this.field().nativeElement;
    if (this.readonly() || el.selectionStart !== el.selectionEnd) return this.closeMenu();
    const caret = el.selectionStart;
    const slash = findSlashTrigger(el.value, caret);
    let next: ReturnType<typeof this.menu> = null;
    let anchor = 0;
    if (slash && matchSlashCommands(slash).length) {
      next = { kind: 'slash', trigger: slash };
      anchor = slash.start;
    } else {
      const m = MENTION.exec(el.value.slice(0, caret));
      if (m) {
        const start = caret - m[3].length - 1;
        next = { kind: 'mention', char: m[2] as '@' | '#', query: m[3], start };
        anchor = start;
      }
    }
    if (!next || this.dismissedAt() === caret) {
      if (!next) this.dismissedAt.set(-1);
      this.menu.set(null);
      return;
    }
    const prev = this.menu();
    const queryOf = (m: typeof next) => (m?.kind === 'slash' ? m.trigger.query : m?.query);
    if (!prev || prev.kind !== next.kind || queryOf(prev) !== queryOf(next)) this.active.set(0);
    const c = caretCoords(el, anchor);
    const room = el.clientWidth - MENU_WIDTH - 8;
    this.menuPos.set({
      top: Math.max(0, c.top + c.height + 16),
      left: Math.max(8, Math.min(c.left + 16, room)),
    });
    this.menu.set(next);
  }

  private pickSlash(trigger: SlashTrigger, id: string): void {
    const cmd = SLASH_COMMANDS.find((c) => c.id === id);
    if (!cmd) return;
    const today = new Date().toISOString().slice(0, 10);
    this.edit((s) => applySlash(s, trigger, cmd, today));
    if (cmd.id === 'mention') queueMicrotask(() => this.refreshMenu());
  }

  private mentionItems(char: '@' | '#', query: string, start: number): MenuItem[] {
    const q = query.toLowerCase();
    const match = (...parts: string[]) => !q || parts.some((p) => p.toLowerCase().includes(q));
    const out: MenuItem[] = [];
    const add = (id: string, label: string, hint: string, insert: string, actor?: ActorRef) =>
      out.push({ id, label, hint, actor, run: () => this.pickMention(start, insert) });
    if (char === '@') {
      let n = 0;
      for (const m of this.store.members()) {
        if (n >= MAX_ITEMS) break;
        if (match(m.user.name)) {
          add(m.user.id, m.user.name, m.membership.role, `@${m.user.name}`, {
            type: 'user',
            id: m.user.id,
          });
          n++;
        }
      }
      for (const a of this.store.agents()) {
        if (n >= MAX_ITEMS) break;
        if (match(a.name)) {
          add(a.id, a.name, 'agent', `@${a.name}`, { type: 'agent', id: a.id });
          n++;
        }
      }
    }
    const take = <T extends { id: string }>(
      rows: readonly T[],
      f: (r: T) => [string, string, string] | null,
    ) => {
      let n = 0;
      for (const r of rows) {
        if (n >= PER_KIND) break;
        const hit = f(r);
        if (hit) {
          add(r.id, hit[0], hit[1], hit[2]);
          n++;
        }
      }
    };
    take(this.store.workstreams(), (w) => (match(w.key, w.title) ? [w.title, w.key, w.key] : null));
    take(this.store.issues(), (i) => (match(i.key, i.title) ? [i.title, i.key, i.key] : null));
    take(this.store.decisions(), (d) => (match(d.key, d.title) ? [d.title, d.key, d.key] : null));
    const slug = this.store.slug() ?? '';
    for (const d of this.docHits())
      add(
        d.id,
        d.title,
        'doc',
        `[${d.title.replace(/[[\]]/g, '')}](/${encodeURIComponent(slug)}/documents/${d.id})`,
      );
    return out.slice(0, MAX_ITEMS + PER_KIND);
  }

  private pickMention(start: number, insert: string): void {
    this.edit((s) => {
      const text = `${insert} `;
      const at = start + text.length;
      return { from: start, to: s.start, insert: text, selStart: at, selEnd: at };
    });
  }
}
