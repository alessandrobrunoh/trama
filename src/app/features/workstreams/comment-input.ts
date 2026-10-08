// Comment textarea with `@person` and `#record` suggestions and optional `:emoji:` conversion.
import { ChangeDetectionStrategy, Component, computed, ElementRef, afterNextRender, inject, input, model, output, signal, viewChild } from '@angular/core';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { NablaStore, Preferences, type ActorRef } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { replaceEmojiShortcodes } from '../../shared/emoji';

interface Suggestion {
  id: string;
  /** Text that replaces the typed trigger (`@Ada Lovelace`, `AUTH-42`). */
  insert: string;
  label: string;
  hint?: string;
  actor?: ActorRef;
}

/** `@` or `#` at the start of a word, followed by the characters typed so far. */
const TRIGGER = /(^|\s)([@#])([^\s@#]*)$/;
const MAX_SUGGESTIONS = 8;
const PER_KIND = 4;

@Component({
  selector: 'app-comment-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTextareaImports, ActorAvatar],
  host: { class: 'relative block min-w-0' },
  template: `
    <textarea
      #field
      hlmTextarea
      class="min-h-16 w-full resize-y"
      rows="2"
      role="combobox"
      aria-autocomplete="list"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="open() ? listId : null"
      [attr.aria-activedescendant]="open() ? listId + '-' + active() : null"
      [placeholder]="placeholder()"
      [attr.aria-label]="label() || placeholder()"
      [value]="value()"
      (input)="onInput()"
      (keydown)="onKeydown($event)"
      (keyup)="refresh()"
      (click)="refresh()"
      (blur)="dismissed.set(true)"
    ></textarea>
    @if (open()) {
      <ul
        [id]="listId"
        role="listbox"
        class="bg-popover text-popover-foreground absolute top-full left-0 z-30 mt-1 max-h-64 w-72 max-w-full overflow-y-auto rounded-md border p-1 shadow-md"
      >
        @for (s of suggestions(); track s.id; let i = $index) {
          <li
            role="option"
            [id]="listId + '-' + i"
            [attr.aria-selected]="i === active()"
            class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm"
            [class]="i === active() ? 'bg-accent text-accent-foreground' : ''"
            (mousedown)="$event.preventDefault(); pick(s)"
            (mouseenter)="active.set(i)"
          >
            @if (s.actor) {
              <app-actor-avatar [actor]="s.actor" [size]="16" />
            } @else {
              <span class="text-muted-foreground font-mono text-[11px]">{{ s.hint }}</span>
            }
            <span class="min-w-0 flex-1 truncate">{{ s.label }}</span>
            @if (s.actor && s.hint) {
              <span class="text-muted-foreground text-[11px]">{{ s.hint }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class CommentInput {
  private static nextId = 0;
  private readonly store = inject(NablaStore);
  private readonly prefs = inject(Preferences);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  readonly value = model('');
  readonly placeholder = input('');
  readonly label = input('');
  /** Focus the field (caret at the end) as soon as it is rendered. */
  readonly autofocus = input(false);
  /** Keys the suggestion list did not use (Enter to send, Escape to cancel…). */
  readonly keyed = output<KeyboardEvent>();

  protected readonly listId = `comment-input-${CommentInput.nextId++}`;
  protected readonly active = signal(0);
  protected readonly dismissed = signal(true);
  private readonly trigger = signal<{ char: '@' | '#'; query: string; start: number } | null>(null);

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const t = this.trigger();
    if (!t) return [];
    const q = t.query.toLowerCase();
    const match = (...parts: string[]) => !q || parts.some((p) => p.toLowerCase().includes(q));
    const out: Suggestion[] = [];
    if (t.char === '@') {
      for (const m of this.store.members()) {
        if (match(m.user.name)) out.push({ id: m.user.id, insert: `@${m.user.name}`, label: m.user.name, hint: m.membership.role, actor: { type: 'user', id: m.user.id } });
      }
      for (const a of this.store.agents()) {
        if (match(a.name)) out.push({ id: a.id, insert: `@${a.name}`, label: a.name, hint: 'agent', actor: { type: 'agent', id: a.id } });
      }
      return out.slice(0, MAX_SUGGESTIONS);
    }
    const take = <T extends { id: string }>(rows: readonly T[], f: (r: T) => Suggestion | null) => {
      let n = 0;
      for (const r of rows) {
        if (n >= PER_KIND) break;
        const s = f(r);
        if (s) {
          out.push(s);
          n++;
        }
      }
    };
    take(this.store.workstreams(), (w) => (match(w.key, w.title) ? { id: w.id, insert: w.key, label: w.title, hint: w.key } : null));
    take(this.store.issues(), (i) => (match(i.key, i.title) ? { id: i.id, insert: i.key, label: i.title, hint: i.key } : null));
    take(this.store.decisions(), (d) => (match(d.key, d.title) ? { id: d.id, insert: d.key, label: d.title, hint: d.key } : null));
    take(this.store.repositories(), (r) => (match(r.fullName) ? { id: r.id, insert: r.fullName, label: r.fullName, hint: 'repo' } : null));
    return out.slice(0, MAX_SUGGESTIONS);
  });

  protected readonly open = computed(() => !this.dismissed() && this.suggestions().length > 0);

  constructor() {
    afterNextRender(() => {
      if (!this.autofocus()) return;
      const el = this.field().nativeElement;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  focus(): void {
    this.field().nativeElement.focus();
  }

  protected onInput(): void {
    const el = this.field().nativeElement;
    if (this.prefs.emojiShortcodes()) {
      const caret = el.selectionStart;
      const before = replaceEmojiShortcodes(el.value.slice(0, caret));
      const next = before + replaceEmojiShortcodes(el.value.slice(caret));
      if (next !== el.value) {
        el.value = next;
        el.setSelectionRange(before.length, before.length);
      }
    }
    this.value.set(el.value);
    this.dismissed.set(false);
    this.refresh();
  }

  /** Re-reads the word before the caret to decide whether a suggestion list applies. */
  protected refresh(): void {
    const el = this.field().nativeElement;
    const upto = el.value.slice(0, el.selectionStart);
    const m = TRIGGER.exec(upto);
    const next = m ? { char: m[2] as '@' | '#', query: m[3], start: upto.length - m[3].length - 1 } : null;
    const prev = this.trigger();
    if (next?.char !== prev?.char || next?.query !== prev?.query) this.active.set(0);
    this.trigger.set(next);
    if (!next) this.dismissed.set(false);
  }

  protected onKeydown(ev: KeyboardEvent): void {
    if (this.open() && !ev.isComposing) {
      const n = this.suggestions().length;
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
          this.pick(this.suggestions()[this.active()]);
          return;
        case 'Escape':
          ev.preventDefault();
          ev.stopPropagation();
          this.dismissed.set(true);
          return;
      }
    }
    this.keyed.emit(ev);
  }

  protected pick(s: Suggestion | undefined): void {
    const t = this.trigger();
    if (!s || !t) return;
    const el = this.field().nativeElement;
    const end = el.selectionStart;
    const next = `${el.value.slice(0, t.start)}${s.insert} ${el.value.slice(end)}`;
    const caret = t.start + s.insert.length + 1;
    el.value = next;
    el.setSelectionRange(caret, caret);
    el.focus();
    this.value.set(next);
    this.trigger.set(null);
  }
}
