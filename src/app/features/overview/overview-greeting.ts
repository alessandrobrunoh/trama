import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideChartGantt, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { format } from 'date-fns';
import { NablaStore, UiStore } from '../../core';
import { Kbd } from '../../shared/kbd';
import { OverviewModel } from './overview-model';

/** "Good morning, Ada", today's date with a one-sentence status, and the three quick actions. */
@Component({
  selector: 'app-overview-greeting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, Kbd],
  host: { class: 'flex flex-wrap items-end justify-between gap-x-6 gap-y-4' },
  template: `
    <div class="min-w-0">
      <h1 class="text-xl font-semibold tracking-tight">{{ greeting() }}</h1>
      <p class="text-muted-foreground mt-1 text-[13px]">
        <span class="tabular-nums">{{ today }}</span>
        <span aria-hidden="true"> · </span>
        <span>{{ m.statusLine() }}</span>
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      @if (store.allowed('createIssues')) {
        <button hlmBtn size="sm" (click)="ui.openCreate('issue')">
          <svg [lucideIcon]="plus" [size]="14"></svg> New issue <app-kbd keys="c" class="max-sm:hidden" />
        </button>
      }
      @if (store.allowed('createWorkstreams')) {
        <button hlmBtn size="sm" variant="outline" (click)="ui.openCreate('workstream')">
          <svg [lucideIcon]="plus" [size]="14"></svg> New workstream
        </button>
      }
      <a hlmBtn size="sm" variant="ghost" [routerLink]="['/', m.slug(), 'timeline']">
        <svg [lucideIcon]="timeline" [size]="14"></svg> Open timeline
      </a>
    </div>
  `,
})
export class OverviewGreeting {
  protected readonly m = inject(OverviewModel);
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly plus = LucidePlus;
  protected readonly timeline = LucideChartGantt;
  protected readonly today = format(new Date(), 'EEEE, MMMM d');

  protected readonly greeting = computed(() => {
    const h = new Date().getHours();
    const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const name = this.m.firstName();
    return name ? `${part}, ${name}` : part;
  });
}
