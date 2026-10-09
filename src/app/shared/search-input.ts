import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  model,
  viewChild,
} from '@angular/core';
import { LucideDynamicIcon, LucideSearch } from '@lucide/angular';
import { HlmInputImports } from '@spartan-ng/helm/input';

/**
 * The text filter every list page puts first in its toolbar. One size, one icon, and Escape clears
 * the text (and leaves the field), so the lists behave alike.
 *   <app-search-input noun="projects" [(value)]="search" />
 * `noun` builds the placeholder ("Search projects…") and the accessible name; pass `placeholder`
 * when the field also matches something other than the name (e.g. "Search name or domain…").
 */
@Component({
  selector: 'app-search-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmInputImports, LucideDynamicIcon],
  host: { class: 'relative block w-full sm:w-52' },
  template: `
    <svg
      [lucideIcon]="searchIcon"
      [size]="14"
      class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
    ></svg>
    <input
      #box
      hlmInput
      type="text"
      class="h-7 w-full pl-8 text-xs max-sm:h-9"
      autocomplete="off"
      [placeholder]="placeholder() || 'Search ' + noun() + '…'"
      [attr.aria-label]="'Search ' + noun()"
      [value]="value()"
      (input)="value.set(box.value)"
      (keydown.escape)="clear(box)"
    />
  `,
})
export class SearchInput {
  /** What is being searched, plural and lowercase: "projects". */
  readonly noun = input.required<string>();
  readonly placeholder = input('');
  readonly value = model('');

  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');
  protected readonly searchIcon = LucideSearch;

  focus(): void {
    this.box().nativeElement.focus();
  }

  protected clear(box: HTMLInputElement): void {
    this.value.set('');
    box.blur();
  }
}
