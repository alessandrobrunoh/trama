import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ReleaseStatus } from '../../core';
import { RELEASE_STATUS_META } from './release-model';

@Component({
  selector: 'app-release-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <span
      class="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
      [class]="meta().pill"
    >
      {{ meta().label }}
    </span>
  `,
})
export class ReleaseStatusBadge {
  readonly status = input.required<ReleaseStatus>();
  protected readonly meta = computed(() => RELEASE_STATUS_META[this.status()]);
}
