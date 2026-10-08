import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { LucideDynamicIcon, LucidePlus, LucideX } from '@lucide/angular';

/**
 * Tag chips with remove (×) and an inline "add tag" input. Enter adds the typed tag (or the
 * highlighted suggestion), Backspace on an empty input removes the last tag, Esc closes.
 *   <app-decision-tags [tags]="d.tags" [suggestions]="allTags()" (tagsChange)="save($event)" />
 */
@Component({
  selector: 'app-decision-tags',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'relative flex min-w-0 flex-wrap items-center gap-1' },
  template: `
    @for (t of tags(); track t) {
      <span class="border-border-strong inline-flex h-6 items-center gap-1 rounded-full border ps-2 pe-1 text-xs">
        {{ t }}
        @if (canEdit()) {
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-4 items-center justify-center rounded-full"
            [attr.aria-label]="'Remove tag ' + t"
            (click)="remove(t)"
          >
            <svg [lucideIcon]="x" [size]="11"></svg>
          </button>
        }
      </span>
    }
    @if (canEdit()) {
      @if (adding()) {
        <div class="relative">
          <input
            #inp
            class="border-border-strong bg-background focus:border-ring h-6 w-32 rounded-full border px-2 text-xs outline-none"
            placeholder="Add tag…"
            aria-label="Add tag"
            [value]="draft()"
            (input)="onInput($any($event.target).value)"
            (keydown.enter)="$event.preventDefault(); commit()"
            (keydown.escape)="$event.stopPropagation(); close()"
            (keydown.arrowdown)="$event.preventDefault(); move(1)"
            (keydown.arrowup)="$event.preventDefault(); move(-1)"
            (keydown.backspace)="onBackspace()"
            (blur)="onBlur()"
          />
          @if (matches().length) {
            <ul
              class="bg-popover text-popover-foreground absolute top-7 left-0 z-50 max-h-48 w-44 overflow-y-auto rounded-md p-1 shadow-md"
              role="listbox"
            >
              @for (s of matches(); track s; let i = $index) {
                <li>
                  <button
                    type="button"
                    role="option"
                    class="hover:bg-accent flex w-full items-center rounded px-2 py-1 text-left text-xs"
                    [class.bg-accent]="i === active()"
                    [attr.aria-selected]="i === active()"
                    (mousedown)="$event.preventDefault(); add(s)"
                  >
                    {{ s }}
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      } @else {
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs"
          (click)="open()"
        >
          <svg [lucideIcon]="plus" [size]="12"></svg>
          {{ tags().length ? '' : 'Add tag' }}
        </button>
      }
    } @else if (!tags().length) {
      <span class="text-muted-foreground text-sm">None</span>
    }
  `,
})
export class DecisionTags {
  readonly tags = input<readonly string[]>([]);
  readonly suggestions = input<readonly string[]>([]);
  readonly canEdit = input(true);
  readonly tagsChange = output<string[]>();

  protected readonly x = LucideX;
  protected readonly plus = LucidePlus;
  protected readonly adding = signal(false);
  protected readonly draft = signal('');
  protected readonly active = signal(-1);
  private readonly inp = viewChild<ElementRef<HTMLInputElement>>('inp');

  protected readonly matches = computed(() => {
    const q = this.draft().trim().toLowerCase();
    const have = new Set(this.tags());
    return this.suggestions()
      .filter((s) => !have.has(s) && (!q || s.toLowerCase().includes(q)))
      .slice(0, 8);
  });

  constructor() {
    effect(() => this.inp()?.nativeElement.focus());
  }

  protected open(): void {
    this.draft.set('');
    this.active.set(-1);
    this.adding.set(true);
  }

  protected close(): void {
    this.adding.set(false);
    this.draft.set('');
  }

  protected onInput(v: string): void {
    this.draft.set(v);
    this.active.set(-1);
  }

  protected move(delta: number): void {
    const n = this.matches().length;
    if (!n) return;
    this.active.update((i) => (i + delta + n) % n);
  }

  protected commit(): void {
    const pick = this.matches()[this.active()];
    const value = pick ?? this.draft();
    if (value.trim()) this.add(value);
    else this.close();
  }

  protected add(tag: string): void {
    const t = tag.trim().replace(/,+$/, '').trim();
    if (!t) return;
    if (!this.tags().includes(t)) this.tagsChange.emit([...this.tags(), t]);
    this.draft.set('');
    this.active.set(-1);
  }

  protected remove(tag: string): void {
    this.tagsChange.emit(this.tags().filter((t) => t !== tag));
  }

  protected onBackspace(): void {
    const list = this.tags();
    if (!this.draft() && list.length) this.remove(list[list.length - 1]);
  }

  protected onBlur(): void {
    if (this.draft().trim()) this.add(this.draft());
    this.close();
  }
}
