// Building blocks of the task page: the inline title and description editors. The task's story (subtasks, the
// thread record, the activity) is `IssueStream` in ./issue-stream.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { TramaStore } from '../../core';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { UploadFile } from '../../shared/upload-file';

// ───────────────────────── title ─────────────────────────

/** The task title (Newsreader 36, tight tracking) in the page header; click to edit (Enter saves, Esc cancels, blur saves). */
@Component({
  selector: 'app-issue-title',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @if (editing()) {
      <textarea
        #ta
        rows="1"
        class="font-title w-full resize-none overflow-hidden bg-transparent text-[30px] leading-[1.2] tracking-[-0.5px]! outline-none md:text-[36px] md:leading-[36.5px]"
        aria-label="Task title"
        [value]="draft()"
        (input)="onInput($event)"
        (keydown.enter)="$event.preventDefault(); commit()"
        (keydown.escape)="cancel($event)"
        (blur)="commit()"
      ></textarea>
    } @else {
      <h1
        class="font-title text-foreground -mx-1 px-1 text-[30px] leading-[1.2] tracking-[-0.5px]! break-words md:text-[36px] md:leading-[36.5px]"
        [class]="canEdit() ? 'hover:bg-hover cursor-text' : ''"
        [attr.role]="canEdit() ? 'button' : null"
        [attr.tabindex]="canEdit() ? 0 : null"
        [attr.aria-label]="canEdit() ? 'Edit title: ' + value() : null"
        (click)="start()"
        (keydown.enter)="start()"
      >
        {{ value() }}
      </h1>
    }
  `,
})
export class IssueTitle {
  readonly value = input.required<string>();
  readonly canEdit = input(true);
  readonly save = output<string>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private skip = false;

  constructor() {
    effect(() => {
      const el = this.ta()?.nativeElement;
      if (!el) return;
      this.autosize(el);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  /** Programmatic entry point (keyboard shortcut). */
  start(): void {
    if (!this.canEdit()) return;
    this.draft.set(this.value());
    this.editing.set(true);
  }

  protected onInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    this.draft.set(el.value.replace(/\n/g, ' '));
    this.autosize(el);
  }

  protected commit(): void {
    if (!this.editing() || this.skip) return;
    const v = this.draft().trim();
    this.editing.set(false);
    if (v && v !== this.value().trim()) this.save.emit(v);
  }

  protected cancel(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.skip = true;
    this.editing.set(false);
    queueMicrotask(() => (this.skip = false));
  }

  private autosize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
}

// ───────────────────────── description ─────────────────────────

/** Markdown description (Plex Sans 14.5 / 22): click to edit, Write / Preview tabs, ⌘↵ saves, Esc cancels. */
@Component({
  selector: 'app-issue-description',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTextareaImports, HlmButtonImports, Markdown, Kbd, UploadFile],
  host: { class: 'block' },
  template: `
    @if (editing()) {
      <div class="border-input border">
        <div class="flex items-center gap-0.5 px-1.5 py-1">
          <button
            type="button"
            class="h-6 px-2 font-mono text-[11px]"
            [class]="
              tab() === 'write'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="tab.set('write')"
          >
            Write
          </button>
          <button
            type="button"
            class="h-6 px-2 font-mono text-[11px]"
            [class]="
              tab() === 'preview'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="tab.set('preview')"
          >
            Preview
          </button>
          <app-upload-file
            class="ml-auto"
            label="Image or file"
            variant="ghost"
            size="xs"
            [busy]="uploading()"
            (file)="addFile($event)"
          />
          <span class="text-meta pr-1">Markdown</span>
        </div>
        @if (tab() === 'write') {
          <textarea
            #ta
            class="min-h-40 w-full resize-y bg-transparent px-3 py-2.5 text-[14.5px] leading-[22px] outline-none"
            aria-label="Description"
            placeholder="Steps to reproduce, expected vs. actual, links, screenshots…"
            [value]="draft()"
            (input)="draft.set($any($event.target).value)"
            (keydown.meta.enter)="commit()"
            (keydown.control.enter)="commit()"
            (keydown.escape)="cancel($event)"
          ></textarea>
        } @else {
          <div class="min-h-40 px-3 py-2.5">
            @if (draft().trim()) {
              <app-markdown [source]="draft()" class="text-[14.5px]! leading-[22px]!" />
            } @else {
              <p class="text-muted-foreground text-sm">Nothing to preview.</p>
            }
          </div>
        }
        <div class="flex items-center justify-end gap-2 px-2 py-1.5">
          <button hlmBtn variant="ghost" type="button" (click)="cancel()">Cancel</button>
          <button hlmBtn type="button" (click)="commit()">
            Save <app-kbd keys="mod+enter" />
          </button>
        </div>
      </div>
    } @else {
      <div
        class="-mx-1 px-1"
        [class]="canEdit() ? 'hover:bg-hover cursor-text' : ''"
        [attr.role]="canEdit() ? 'button' : null"
        [attr.tabindex]="canEdit() ? 0 : null"
        [attr.aria-label]="canEdit() ? 'Edit description' : null"
        (click)="onClick($event)"
        (keydown.enter)="start()"
      >
        @if (value().trim()) {
          <app-markdown
            [source]="value()"
            class="block text-[14.5px]! leading-[22px]! text-text-2 [&_a]:underline [&_a]:underline-offset-2"
          />
        } @else {
          <p class="text-faint text-[14.5px] leading-[22px]">
            {{
              canEdit()
                ? 'Add a description: steps to reproduce, who is affected, links…'
                : 'No description.'
            }}
          </p>
        }
      </div>
    }
  `,
})
export class IssueDescription {
  private readonly store = inject(TramaStore);
  readonly value = input('');
  readonly canEdit = input(true);
  readonly save = output<string>();
  protected readonly editing = signal(false);
  protected readonly tab = signal<'write' | 'preview'>('write');
  protected readonly draft = signal('');
  protected readonly uploading = signal(false);
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

  start(): void {
    if (!this.canEdit() || this.editing()) return;
    this.draft.set(this.value());
    this.tab.set('write');
    this.editing.set(true);
  }

  protected async addFile(file: File): Promise<void> {
    if (this.uploading()) return;
    this.tab.set('write');
    this.uploading.set(true);
    try {
      const markdown = await this.store.stageUpload(file);
      if (markdown) this.insert(this.draft().trim() ? `\n\n${markdown}\n` : `${markdown}\n`);
    } finally {
      this.uploading.set(false);
    }
  }

  private insert(text: string): void {
    const el = this.ta()?.nativeElement;
    if (!el) {
      this.draft.update((v) => v + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
    el.value = next;
    el.setSelectionRange(start + text.length, start + text.length);
    this.draft.set(next);
    el.focus();
  }

  protected onClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('a, input')) return;
    this.start();
  }

  protected commit(): void {
    const v = this.draft().trim();
    this.editing.set(false);
    if (v !== this.value().trim()) this.save.emit(v);
  }

  protected cancel(e?: Event): void {
    e?.stopPropagation();
    e?.preventDefault();
    this.store.discardDraftUploads(this.value(), this.draft());
    this.editing.set(false);
  }
}
