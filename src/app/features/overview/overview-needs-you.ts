import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideCheckCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ATTENTION_KIND_META } from '../../core';
import { EntityChip } from '../../shared/entity-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { KeyChip } from '../../shared/key-chip';
import { ATTENTION_KIND_VIEW, SEVERITY_VIEW } from '../attention/attention-kinds';
import { AgoPipe } from './ago';
import { OverviewModel } from './overview-model';

/** What needs me right now (top 5 attention items) and the issues I have in progress. */
@Component({
  selector: 'app-overview-needs-you',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, HlmTooltip, EntityChip, PriorityIcon, StatusIcon, KeyChip, AgoPipe],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="ov-needs" class="bg-card rounded-lg border">
      <header class="flex items-center gap-2.5 px-4 pt-3 pb-2">
        <h2 id="ov-needs" class="text-sm font-medium">Needs you</h2>
        @if (m.attentionCount() > 0) {
          <span class="bg-status-needs-input/15 text-status-needs-input inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">{{ m.attentionCount() }}</span>
        }
        <span class="flex-1"></span>
        @for (k of m.attentionKinds().slice(0, 3); track k.kind) {
          <span class="text-meta flex items-center gap-1 max-md:hidden" [hlmTooltip]="k.label" position="bottom">
            <svg [lucideIcon]="view[k.kind].icon" [size]="12" [class]="view[k.kind].color"></svg>
            <span class="tabular-nums">{{ k.count }}</span>
          </span>
        }
      </header>

      @if (m.attentionRows().length === 0) {
        <div class="flex flex-col items-center gap-1 px-4 py-8 text-center">
          <span class="bg-status-shipped/10 text-status-shipped mb-1 inline-flex size-9 items-center justify-center rounded-full">
            <svg [lucideIcon]="check" [size]="18"></svg>
          </span>
          <p class="text-sm font-medium">You're clear</p>
          <p class="text-meta max-w-sm">No questions, reviews or decisions are waiting on you. New ones show up here the moment they appear.</p>
        </div>
      } @else {
        <ul>
          @for (r of m.attentionRows(); track r.item.id) {
            <li class="group/row hover:bg-hover relative border-t first:border-t-0">
              <span class="absolute inset-y-0 start-0 w-0.5 rounded-e" [class]="severity[r.item.severity].bar" aria-hidden="true"></span>
              <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 max-sm:grid-cols-[auto_minmax(0,1fr)]">
                <span class="inline-flex" [hlmTooltip]="kindLabel[r.item.kind]" position="left">
                  <svg [lucideIcon]="view[r.item.kind].icon" [size]="16" [strokeWidth]="1.75" [class]="view[r.item.kind].color"></svg>
                </span>
                <div class="min-w-0">
                  <a [routerLink]="r.commands" [queryParams]="r.query" class="block truncate text-[13px] font-medium hover:underline focus-visible:underline focus-visible:outline-none">{{ r.item.title }}</a>
                  <div class="text-meta mt-0.5 flex min-w-0 items-center gap-2">
                    @if (r.chip; as c) {
                      <app-entity-chip [type]="c.type" [ref]="c.ref" compact />
                    }
                    <span class="shrink-0 tabular-nums">since {{ r.item.since | ago }}</span>
                    @if (r.item.detail) {
                      <span class="truncate max-sm:hidden">{{ r.item.detail }}</span>
                    }
                  </div>
                </div>
                <a hlmBtn variant="outline" size="sm" [routerLink]="r.commands" [queryParams]="r.query" class="max-sm:col-start-2 max-sm:justify-self-start">
                  Open <svg [lucideIcon]="arrow" [size]="13"></svg>
                </a>
              </div>
            </li>
          }
        </ul>
        <footer class="border-t px-4 py-2">
          <a [routerLink]="['/', m.slug(), 'attention']" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            See all {{ m.attentionCount() }} in My Attention <svg [lucideIcon]="arrow" [size]="12"></svg>
          </a>
        </footer>
      }
    </section>

    @if (m.assignedTop().length > 0) {
      <section aria-labelledby="ov-assigned" class="mt-6">
        <header class="mb-1 flex items-baseline gap-3">
          <h2 id="ov-assigned" class="text-sm font-medium">Assigned to me</h2>
          <span class="text-meta">in progress</span>
          <span class="flex-1"></span>
          <a [routerLink]="['/', m.slug(), 'my-work']" class="text-meta hover:text-foreground inline-flex items-center gap-1">
            @if (m.assigned().length > m.assignedTop().length) {
              {{ m.assigned().length }} in progress
            } @else {
              My work
            }
            <svg [lucideIcon]="arrow" [size]="12"></svg>
          </a>
        </header>
        <ul>
          @for (i of m.assignedTop(); track i.id) {
            <li>
              <a [routerLink]="['/', m.slug(), 'issues', i.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2.5 rounded-md px-2">
                <app-status-icon entity="issue" [status]="i.status" />
                <app-key-chip [value]="i.key" class="w-[4.5rem] shrink-0 max-sm:w-auto" />
                <span class="min-w-0 flex-1 truncate text-[13px]">{{ i.title }}</span>
                <app-priority-icon [priority]="i.priority" />
              </a>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class OverviewNeedsYou {
  protected readonly m = inject(OverviewModel);
  protected readonly view = ATTENTION_KIND_VIEW;
  protected readonly severity = SEVERITY_VIEW;
  protected readonly kindLabel = Object.fromEntries(Object.entries(ATTENTION_KIND_META).map(([k, v]) => [k, v.label])) as Record<string, string>;
  protected readonly arrow = LucideArrowRight;
  protected readonly check = LucideCheckCheck;
}
