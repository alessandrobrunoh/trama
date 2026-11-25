import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideArrowUpRight,
  LucideCircle,
  LucideCircleCheck,
  LucideCircleDashed,
  LucideCircleDot,
  LucideDynamicIcon,
} from '@lucide/angular';
import { format, isToday, parseISO } from 'date-fns';
import { ApiClient } from '../../core/api/api-client';
import type {
  Priority,
  PublicView as PublicViewDto,
  PublicViewGroup,
  PublicViewItem,
} from '../../core/contracts/domain';
import { ISSUE_STATUS_META } from '../../core/meta';
import { initials } from '../../core/utils';

/** Done rows shown in the narrow right-hand column. */
const DONE_ROWS = 5;

/** Avatar fills and their initials colour (DESIGN.md "Avatar colours"; the roadmap frame tints per fill). */
const AVATARS: readonly { bg: string; fg: string }[] = [
  { bg: '#2B3A5C', fg: '#DCE3F7' },
  { bg: '#4A2C26', fg: '#F3D9D2' },
  { bg: '#2E4430', fg: '#D5EBD7' },
  { bg: '#3F3552', fg: '#E4DCF3' },
];

const PRIORITY_LIT: Record<Priority, number> = { urgent: 3, high: 2, medium: 1, low: 0, none: 0 };
const BAR_HEIGHTS: readonly number[] = [4, 7, 10];

interface Column {
  key: string;
  name: string;
  done: boolean;
  items: PublicViewItem[];
}

/**
 * The live roadmap board (v3 frame 36): the workspace's roadmap Shared View, read-only, shown as one
 * column per status with the Done column as a short list of the most recent tasks.
 */
@Component({
  selector: 'app-roadmap-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideDynamicIcon],
  host: { class: 'flex flex-col gap-5' },
  template: `
    @if (state() === 'missing') {
      <p class="text-faint border-border border px-4 py-6 font-mono text-xs">
        The roadmap view is not available right now.
      </p>
    } @else if (state() === 'ready') {
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p class="text-muted-foreground flex items-center gap-2.5 font-mono text-xs leading-none">
          <span class="bg-green size-[7px] shrink-0" aria-hidden="true"></span>
          Live from the {{ viewName() }} shared view · updated {{ updated() }}
        </p>
        @if (token(); as t) {
          <a
            [routerLink]="['/shared', t]"
            class="text-primary flex items-center gap-1.5 font-mono text-xs leading-none hover:underline"
          >
            Open view <svg [lucideIcon]="openIcon" [size]="12"></svg>
          </a>
        }
      </div>

      <div class="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-4">
        @for (col of columns(); track col.key) {
          @if (col.done) {
            <section class="flex min-w-0 flex-col gap-2 lg:w-[260px] lg:shrink-0" [attr.aria-label]="col.name">
              <header class="flex items-center gap-2 px-0.5 pb-1.5">
                <svg [lucideIcon]="icon(col.key)" [size]="14" [class]="tone(col.key)"></svg>
                <h3 class="text-foreground text-[13.5px] leading-none font-medium">{{ col.name }}</h3>
                <span class="text-faint font-mono text-[11px] leading-none">{{
                  col.items.length
                }}</span>
              </header>
              <div class="border-border flex flex-col border">
                @for (item of recent(col); track item.id) {
                  <div class="border-border flex flex-col gap-1 border-b px-3 py-2.5">
                    <div class="text-faint flex justify-between gap-2 font-mono text-[10.5px] leading-[13px]">
                      <span>{{ item.key }}</span>
                      <span>{{ item.updatedAt | date: 'MMM d' }}</span>
                    </div>
                    <p class="text-muted-foreground text-[12.5px] leading-[16px]">{{ item.title }}</p>
                  </div>
                }
                <a
                  routerLink="/changelog"
                  class="text-primary flex items-center gap-1.5 px-3 py-2.5 font-mono text-[11px] leading-none hover:underline"
                >
                  See the full changelog <svg [lucideIcon]="arrowIcon" [size]="12"></svg>
                </a>
              </div>
            </section>
          } @else {
            <section class="flex min-w-0 flex-col gap-2 lg:flex-1" [attr.aria-label]="col.name">
              <header class="flex items-center gap-2 px-0.5 pb-1.5">
                <svg [lucideIcon]="icon(col.key)" [size]="14" [class]="tone(col.key)"></svg>
                <h3 class="text-foreground text-[13.5px] leading-none font-medium">{{ col.name }}</h3>
                <span class="text-faint font-mono text-[11px] leading-none">{{
                  col.items.length
                }}</span>
              </header>
              @for (item of col.items; track item.id) {
                <article class="bg-card border-border flex flex-col gap-2.5 border p-3">
                  <div class="flex items-center gap-2">
                    <span class="text-faint font-mono text-[11px] leading-none">{{ item.key }}</span>
                    <span class="flex-1"></span>
                    @if (item.assignee; as who) {
                      <span
                        class="inline-flex size-[18px] shrink-0 items-center justify-center font-mono text-[8px] leading-none"
                        [style.background]="avatar(who).bg"
                        [style.color]="avatar(who).fg"
                        [attr.title]="who"
                        >{{ ini(who) }}</span
                      >
                    }
                  </div>
                  <h4 class="text-foreground text-[13.5px] leading-[19px] font-normal">
                    {{ item.title }}
                  </h4>
                  @if (hasMeta(item)) {
                    <div class="flex flex-wrap items-center gap-2">
                      @if (item.priority && item.priority !== 'none') {
                        <span
                          class="flex h-2.5 items-end gap-0.5"
                          role="img"
                          [attr.aria-label]="'Priority: ' + item.priority"
                        >
                          @for (h of barHeights; track $index) {
                            <span
                              class="w-[3px]"
                              [style.height.px]="h"
                              [class]="bar(item.priority, $index)"
                            ></span>
                          }
                        </span>
                      }
                      @for (l of (item.labels ?? []).slice(0, 2); track l) {
                        <span
                          class="border-border text-muted-foreground flex items-center gap-[5px] border px-[7px] py-px font-mono text-[10px] leading-[14px]"
                        >
                          <span class="size-1.5 shrink-0" [class]="labelDot(l)" aria-hidden="true"></span>
                          {{ l }}
                        </span>
                      }
                    </div>
                  }
                </article>
              }
            </section>
          }
        }
      </div>
    }
  `,
})
export class RoadmapBoard {
  private readonly api = inject(ApiClient);

  protected readonly arrowIcon = LucideArrowRight;
  protected readonly openIcon = LucideArrowUpRight;
  protected readonly barHeights = BAR_HEIGHTS;

  protected readonly state = signal<'loading' | 'ready' | 'missing'>('loading');
  protected readonly view = signal<PublicViewDto | null>(null);
  protected readonly token = signal<string | null>(null);

  protected readonly viewName = computed(() => this.view()?.name ?? 'Roadmap');
  protected readonly updated = computed(() => {
    const iso = this.view()?.generatedAt;
    if (!iso) return '';
    const at = parseISO(iso);
    return isToday(at) ? `today ${format(at, 'HH:mm')}` : format(at, 'MMM d HH:mm');
  });

  protected readonly columns = computed<Column[]>(() => {
    const v = this.view();
    if (!v) return [];
    const cols = v.groups.map((g: PublicViewGroup): Column => {
      const status = v.groupBy === 'status' ? ISSUE_STATUS_META[g.key as keyof typeof ISSUE_STATUS_META] : undefined;
      return {
        key: g.key,
        name: status?.label ?? (g.label || 'None'),
        done: g.key === 'done',
        items: g.items,
      };
    });
    // The Done list sits on the right, as in the frame.
    return [...cols.filter((c) => !c.done), ...cols.filter((c) => c.done)];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const config = await this.api.publicConfig();
      if (!config.roadmapViewToken) {
        this.state.set('missing');
        return;
      }
      this.token.set(config.roadmapViewToken);
      this.view.set(await this.api.publicViews.get(config.roadmapViewToken));
      this.state.set('ready');
    } catch {
      this.state.set('missing');
    }
  }

  protected recent(col: Column): PublicViewItem[] {
    return [...col.items]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, DONE_ROWS);
  }

  protected icon(key: string) {
    if (key === 'done') return LucideCircleCheck;
    if (key === 'in_progress') return LucideCircleDot;
    if (key === 'backlog') return LucideCircleDashed;
    return LucideCircle;
  }

  protected tone(key: string): string {
    if (key === 'done') return 'text-green';
    if (key === 'in_progress') return 'text-status-in-progress';
    if (key === 'in_review') return 'text-delta-line';
    return 'text-muted-foreground';
  }

  protected hasMeta(item: PublicViewItem): boolean {
    return (!!item.priority && item.priority !== 'none') || (item.labels?.length ?? 0) > 0;
  }

  protected bar(priority: Priority, index: number): string {
    return index < PRIORITY_LIT[priority] ? 'bg-muted-foreground' : 'bg-border';
  }

  protected labelDot(label: string): string {
    const l = label.toLowerCase();
    if (l === 'feature') return 'bg-primary';
    if (l === 'improvement') return 'bg-delta-line';
    if (l === 'bug') return 'bg-red';
    return 'bg-faint';
  }

  protected ini(name: string): string {
    return initials(name);
  }

  protected avatar(name: string): { bg: string; fg: string } {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATARS[hash % AVATARS.length];
  }
}
