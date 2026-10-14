// Comment textarea with `@person` and `#record` suggestions and optional `:emoji:` conversion.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { TramaStore, Preferences, type ActorRef } from '../core';
import { ActorAvatar } from './actor-avatar';
import { replaceEmojiShortcodes } from './emoji';

interface Suggestion {
  id: string;
  insert: string;
  label: string;
  hint?: string;
  actor?: ActorRef;
}

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
  private readonly store = inject(TramaStore);
  private readonly prefs = inject(Preferences);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  readonly value = model('');
  readonly placeholder = input('');
  readonly label = input('');
  readonly autofocus = input(false);
  readonly keyed = output<KeyboardEvent>();

  protected readonly listId = `comment-input-${CommentInput.nextId++}`;
  protected readonly active = signal(0);
  protected readonly dismissed = signal(true);
  private readonly trigger = signal<{ char: '@' | '#'; query: string; start: number } | null>(null);

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const trigger = this.trigger();
    if (!trigger) return [];
    const query = trigger.query.toLowerCase();
    const match = (...parts: string[]) => !query || parts.some((part) => part.toLowerCase().includes(query));
    const out: Suggestion[] = [];
    if (trigger.char === '@') {
      for (const member of this.store.members()) {
        if (match(member.user.name)) {
          out.push({
            id: member.user.id,
            insert: `@${member.user.name}`,
            label: member.user.name,
            hint: member.membership.role,
            actor: { type: 'user', id: member.user.id },
          });
        }
      }
      for (const agent of this.store.agents()) {
        if (match(agent.name)) {
          out.push({
            id: agent.id,
            insert: `@${agent.name}`,
            label: agent.name,
            hint: 'agent',
            actor: { type: 'agent', id: agent.id },
          });
        }
      }
      return out.slice(0, MAX_SUGGESTIONS);
    }
    const take = <T extends { id: string }>(rows: readonly T[], toSuggestion: (row: T) => Suggestion | null) => {
      let count = 0;
      for (const row of rows) {
        if (count >= PER_KIND) break;
        const suggestion = toSuggestion(row);
        if (suggestion) {
          out.push(suggestion);
          count++;
        }
      }
    };
    take(this.store.issues(), (issue) =>
      match(issue.key, issue.title)
        ? { id: issue.id, insert: issue.key, label: issue.title, hint: issue.key }
        : null,
    );
    take(this.store.decisions(), (decision) =>
      match(decision.key, decision.title)
        ? { id: decision.id, insert: decision.key, label: decision.title, hint: decision.key }
        : null,
    );
    take(this.store.repositories(), (repository) =>
      match(repository.fullName)
        ? { id: repository.id, insert: repository.fullName, label: repository.fullName, hint: 'repo' }
        : null,
    );
    return out.slice(0, MAX_SUGGESTIONS);
  });

  protected readonly open = computed(() => !this.dismissed() && this.suggestions().length > 0);

  constructor() {
    afterNextRender(() => {
      if (!this.autofocus()) return;
      const element = this.field().nativeElement;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  }

  focus(): void {
    this.field().nativeElement.focus();
  }

  insert(text: string): void {
    const element = this.field().nativeElement;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const next = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`;
    element.value = next;
    element.setSelectionRange(start + text.length, start + text.length);
    this.value.set(next);
    element.focus();
  }

  protected onInput(): void {
    const element = this.field().nativeElement;
    if (this.prefs.emojiShortcodes()) {
      const caret = element.selectionStart;
      const before = replaceEmojiShortcodes(element.value.slice(0, caret));
      const next = before + replaceEmojiShortcodes(element.value.slice(caret));
      if (next !== element.value) {
        element.value = next;
        element.setSelectionRange(before.length, before.length);
      }
    }
    this.value.set(element.value);
    this.dismissed.set(false);
    this.refresh();
  }

  protected refresh(): void {
    const element = this.field().nativeElement;
    const upto = element.value.slice(0, element.selectionStart);
    const match = TRIGGER.exec(upto);
    const next = match
      ? { char: match[2] as '@' | '#', query: match[3], start: upto.length - match[3].length - 1 }
      : null;
    const previous = this.trigger();
    if (next?.char !== previous?.char || next?.query !== previous?.query) this.active.set(0);
    this.trigger.set(next);
    if (!next) this.dismissed.set(false);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.open() && !event.isComposing) {
      const count = this.suggestions().length;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          this.active.update((index) => (index + 1) % count);
          return;
        case 'ArrowUp':
          event.preventDefault();
          this.active.update((index) => (index - 1 + count) % count);
          return;
        case 'Enter':
        case 'Tab':
          if (event.shiftKey || event.metaKey || event.ctrlKey) break;
          event.preventDefault();
          this.pick(this.suggestions()[this.active()]);
          return;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          this.dismissed.set(true);
          return;
      }
    }
    this.keyed.emit(event);
  }

  protected pick(suggestion: Suggestion | undefined): void {
    const trigger = this.trigger();
    if (!suggestion || !trigger) return;
    const element = this.field().nativeElement;
    const end = element.selectionStart;
    const next = `${element.value.slice(0, trigger.start)}${suggestion.insert} ${element.value.slice(end)}`;
    const caret = trigger.start + suggestion.insert.length + 1;
    element.value = next;
    element.setSelectionRange(caret, caret);
    element.focus();
    this.value.set(next);
    this.trigger.set(null);
  }
}
