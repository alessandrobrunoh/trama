import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { Customer } from '../../core/contracts/domain';

/** Company logo, or the first letter of the name when there is none or it fails to load. */
@Component({
  selector: 'app-customer-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (src(); as url) {
      <img
        [src]="url"
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        class="bg-muted rounded object-contain"
        [style.width.px]="size()"
        [style.height.px]="size()"
        (error)="failed.set(url)"
      />
    } @else {
      <span
        class="bg-muted text-muted-foreground inline-flex items-center justify-center rounded font-medium uppercase"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.font-size.px]="size() * 0.5"
        aria-hidden="true"
        >{{ initial() }}</span
      >
    }
  `,
})
export class CustomerAvatar {
  readonly customer = input.required<Pick<Customer, 'name' | 'logoUrl'>>();
  readonly size = input(20);

  /** The logo URL that failed to load, so a later different URL is tried again. */
  protected readonly failed = signal<string | null>(null);
  protected readonly src = computed(() => {
    const url = this.customer().logoUrl;
    return url && url !== this.failed() ? url : null;
  });
  protected readonly initial = computed(() => (this.customer().name.trim()[0] ?? '?'));
}
