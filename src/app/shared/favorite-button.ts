import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideDynamicIcon, LucideStar } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import type { FavoriteType, ID } from '../core/contracts/domain';
import { FavoritesStore } from '../core/stores/favorites.store';

/**
 * Star that pins an entity to the sidebar's Favorites.
 *   <app-favorite-button type="issue" [subjectId]="issue.id" />
 */
@Component({
  selector: 'app-favorite-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTooltip, LucideDynamicIcon],
  host: { class: 'inline-flex' },
  template: `
    <button
      hlmBtn
      variant="ghost"
      size="icon-sm"
      class="size-7"
      [class]="active() ? 'text-tone-amber' : 'text-muted-foreground'"
      type="button"
      [attr.aria-pressed]="active()"
      [attr.aria-label]="label()"
      [hlmTooltip]="label()"
      position="bottom"
      (click)="toggle()"
    >
      <svg [lucideIcon]="star" [size]="15" [attr.fill]="active() ? 'currentColor' : 'none'"></svg>
    </button>
  `,
})
export class FavoriteButton {
  private readonly favorites = inject(FavoritesStore);

  readonly type = input.required<FavoriteType>();
  readonly subjectId = input.required<ID>();

  protected readonly star = LucideStar;
  protected readonly active = computed(() => this.favorites.has(this.type(), this.subjectId()));
  protected readonly label = computed(() => (this.active() ? 'Remove from favorites' : 'Add to favorites'));

  protected toggle(): void {
    void this.favorites.toggle(this.type(), this.subjectId());
  }
}
