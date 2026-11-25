import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TramaStore } from '../../core/stores/trama.store';

/** The three Time pages as a segmented control (v3 · 01 UI Kit → Segmented), in the top bar of each page. */
@Component({
  selector: 'app-time-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  host: { class: 'flex items-center', role: 'group', 'aria-label': 'Time views' },
  template: `
    @for (t of tabs(); track t.label) {
      <a
        class="border-border text-muted-foreground -ms-px inline-flex h-[22px] items-center border px-2.5 font-mono text-[11px] first:ms-0"
        [routerLink]="t.link"
        routerLinkActive="bg-secondary text-foreground"
        [routerLinkActiveOptions]="{ exact: true }"
        ariaCurrentWhenActive="page"
        >{{ t.label }}</a
      >
    }
  `,
})
export class TimeTabs {
  private readonly store = inject(TramaStore);
  protected readonly tabs = computed(() => {
    const base = ['/', this.store.slug() ?? '', 'timer'];
    return [
      { label: 'Timesheet', link: base },
      { label: 'Reports', link: [...base, 'reports'] },
      { label: 'Estimates', link: [...base, 'estimates'] },
    ];
  });
}
