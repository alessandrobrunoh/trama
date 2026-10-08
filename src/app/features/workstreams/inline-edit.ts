// Click-to-edit primitives: single-line text and markdown.
import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, signal, viewChild } from '@angular/core';
import { LucidePencil, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';

/** Single line of text that turns into an input on click (Enter saves, Esc cancels, blur saves). */
@Component({
  selector: 'app-inline-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmInputImports],
  host: { class: 'block min-w-0' },
  template: `
    @if (editing()) {
      <input
        #inp
        hlmInput
        class="h-8 w-full"
        [class.font-mono]="mono()"
        [value]="draft()"
        [attr.aria-label]="label()"
        [placeholder]="placeholder()"
        (input)="draft.set($any($event.target).value)"
        (keydown.enter)="commit()"
        (keydown.escape)="cancel($event)"
        (blur)="commit()"
      />
    } @else {
      <button
        type="button"
        class="hover:bg-accent focus-visible:ring-ring block w-full max-w-full min-w-0 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 disabled:pointer-events-none"
        [class]="textClass()"
        [class.font-mono]="mono()"
        [disabled]="!canEdit()"
        [attr.aria-label]="'Edit ' + label()"
        (click)="start()"
      >
        @if (value()) {
          <span class="block truncate">{{ value() }}</span>
        } @else {
          <span class="text-muted-foreground block truncate">{{ placeholder() }}</span>
        }
      </button>
    }
  `,
})
export class InlineText {
  readonly value = input('');
  readonly label = input('value');
  readonly placeholder = input('Empty');
  readonly canEdit = input(true);
  readonly mono = input(false);
  readonly textClass = input('text-sm');
  /** Allow saving an empty value. */
  readonly allowEmpty = input(false);
  readonly save = output<string>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  private readonly inp = viewChild<ElementRef<HTMLInputElement>>('inp');
  private skipBlur = false;

  constructor() {
    effect(() => {
      const el = this.inp()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }

  /** Enter edit mode (also used by keyboard shortcuts). */
  start(): void {
    if (!this.canEdit()) return;
    this.draft.set(this.value());
    this.editing.set(true);
  }

  protected commit(): void {
    if (!this.editing() || this.skipBlur) return;
    const v = this.draft().trim();
    this.editing.set(false);
    if (v === this.value().trim()) return;
    if (!v && !this.allowEmpty()) return;
    this.save.emit(v);
  }

  protected cancel(e: Event): void {
    e.stopPropagation();
    this.skipBlur = true;
    this.editing.set(false);
    queueMicrotask(() => (this.skipBlur = false));
  }
}

/** Markdown block that becomes a textarea on click (⌘↵ saves, Esc cancels). */
@Component({
  selector: 'app-editable-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTextareaImports, HlmButtonImports, Markdown, Kbd, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    @if (editing()) {
      <textarea
        #ta
        hlmTextarea
        class="min-h-28 w-full resize-y font-sans"
        [value]="draft()"
        [attr.aria-label]="label()"
        [placeholder]="placeholder()"
        (input)="draft.set($any($event.target).value)"
        (keydown.meta.enter)="commit()"
        (keydown.control.enter)="commit()"
        (keydown.escape)="cancel($event)"
      ></textarea>
      <div class="mt-2 flex items-center gap-2">
        <button hlmBtn size="sm" type="button" (click)="commit()">Save <app-kbd keys="mod+enter" class="opacity-70" /></button>
        <button hlmBtn size="sm" variant="ghost" type="button" (click)="editing.set(false)">Cancel</button>
        <span class="text-meta ml-auto">Markdown supported</span>
      </div>
    } @else {
      <div
        class="group/md relative -mx-2 rounded-md px-2 py-1.5"
        [class]="canEdit() ? 'hover:bg-hover cursor-text' : ''"
        [attr.role]="canEdit() ? 'button' : null"
        [attr.tabindex]="canEdit() ? 0 : null"
        [attr.aria-label]="canEdit() ? 'Edit ' + label() : null"
        (click)="onClick($event)"
        (keydown.enter)="start()"
      >
        @if (value().trim()) {
          <app-markdown [source]="value()" />
        } @else {
          <p class="text-muted-foreground text-sm">{{ placeholder() }}</p>
        }
        @if (canEdit()) {
          <svg
            [lucideIcon]="pencil"
            [size]="13"
            class="text-muted-foreground absolute top-2 right-2 opacity-0 group-hover/md:opacity-100"
          ></svg>
        }
      </div>
    }
  `,
})
export class EditableMarkdown {
  readonly value = input('');
  readonly label = input('text');
  readonly placeholder = input('Click to add…');
  readonly canEdit = input(true);
  readonly save = output<string>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly pencil = LucidePencil;
  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');

  constructor() {
    effect(() => {
      const el = this.ta()?.nativeElement;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  protected onClick(e: MouseEvent): void {
    // let links inside the rendered markdown work
    if ((e.target as HTMLElement).closest('a')) return;
    this.start();
  }

  protected start(): void {
    if (!this.canEdit()) return;
    this.draft.set(this.value());
    this.editing.set(true);
  }

  protected commit(): void {
    const v = this.draft().trim();
    this.editing.set(false);
    if (v !== this.value().trim()) this.save.emit(v);
  }

  protected cancel(e: Event): void {
    e.stopPropagation();
    this.editing.set(false);
  }
}
