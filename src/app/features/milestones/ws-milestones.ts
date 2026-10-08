// "Milestones" section of the workstream overview (Linear-style): the progress chart of the whole
// workstream, then the milestone list — drag to reorder, "+" to add (name + optional date),
// click a row to expand its issues and its own chart.
import { CdkDrag, CdkDropList, moveItemInArray, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { LucideCalendar, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, shortDate, type Workstream } from '../../core';
import { WsDatePicker } from '../workstreams/ws-parts';
import { MilestoneActions, isoFromDate } from './milestone-actions';
import { MilestoneIcon } from './milestone-icon';
import { MilestoneRow } from './milestone-row';
import { ProgressChart } from './progress-chart';

@Component({
  selector: 'app-ws-milestones',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropList, CdkDrag, HlmButtonImports, HlmInputImports, LucideDynamicIcon, MilestoneIcon, MilestoneRow, ProgressChart, WsDatePicker],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="ws-milestones-title">
      <header class="mb-2 flex items-center gap-2">
        <app-milestone-icon [size]="15" state="idle" />
        <h2 id="ws-milestones-title" class="text-sm font-semibold">Milestones</h2>
        <span class="text-muted-foreground text-xs">{{ milestones().length }} · stages of this outcome, each with its own issues and date</span>
        @if (canEdit()) {
          <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground hover:text-foreground ml-auto" aria-label="Add milestone" (click)="startAdd()">
            <svg [lucideIcon]="plus" [size]="14"></svg>
          </button>
        }
      </header>

      @if (showChart() && hasIssues()) {
        <div class="bg-card mb-3 rounded-lg border border-border-strong px-3 pt-3 pb-2">
          <app-progress-chart [ws]="ws()" [height]="190" />
        </div>
      }

      <div class="bg-card overflow-hidden rounded-lg border border-border-strong" cdkDropList [cdkDropListDisabled]="!canEdit()" (cdkDropListDropped)="drop($event)">
        @for (m of milestones(); track m.id; let i = $index) {
          <app-milestone-row cdkDrag cdkDragLockAxis="y" class="bg-card border-b last:border-b-0" [ms]="m" [ws]="ws()" [index]="i" [count]="milestones().length" />
        }
        @if (adding()) {
          <div class="flex min-h-10 items-center gap-2 border-t px-2.5 first:border-t-0">
            <app-milestone-icon [size]="15" state="empty" />
            <input
              #nameInput
              hlmInput
              class="h-7 min-w-0 flex-1 border-transparent bg-transparent text-[13px] shadow-none focus-visible:border-input"
              placeholder="Milestone name, Enter to add"
              aria-label="New milestone name"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="add()"
              (keydown.escape)="cancel($event)"
            />
            <app-ws-date-picker label="New milestone target date" align="end" triggerClass="h-7 gap-1.5 border border-border-strong px-2 text-xs" [value]="dateIso()" (dateChange)="date.set($event)">
              <svg [lucideIcon]="cal" [size]="12" class="text-muted-foreground"></svg>
              <span [class.text-muted-foreground]="!date()">{{ date() ? dateLabel() : 'Target date' }}</span>
            </app-ws-date-picker>
            <button hlmBtn size="xs" [disabled]="!draft().trim()" (click)="add()">Add</button>
            <button hlmBtn variant="ghost" size="xs" (click)="adding.set(false)">Cancel</button>
          </div>
        } @else if (!milestones().length) {
          <p class="text-muted-foreground px-3 py-3 text-sm">
            Break this outcome into milestones. Each groups some of its issues and has its own target date.
            @if (canEdit()) {
              <button type="button" class="text-foreground underline-offset-2 hover:underline" (click)="startAdd()">Add the first milestone</button>
            }
          </p>
        }
      </div>
    </section>
  `,
})
export class WsMilestones {
  private readonly store = inject(NablaStore);
  private readonly actions = inject(MilestoneActions);
  readonly ws = input.required<Workstream>();
  /** Show the workstream progress chart above the list. */
  readonly showChart = input(true);

  protected readonly plus = LucidePlus;
  protected readonly cal = LucideCalendar;
  protected readonly adding = signal(false);
  protected readonly draft = signal('');
  protected readonly date = signal<Date | null>(null);
  protected readonly dateIso = computed(() => this.date()?.toISOString());
  protected readonly dateLabel = computed(() => (this.date() ? shortDate(isoFromDate(this.date()!)) : ''));
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly canEdit = computed(() => this.store.canEditTeamWork(this.ws().ownerTeamId));
  protected readonly milestones = computed(() => this.store.milestonesByWorkstream().get(this.ws().id) ?? []);
  protected readonly hasIssues = computed(() => (this.store.issuesByWorkstream().get(this.ws().id) ?? []).some((i) => i.status !== 'canceled'));

  constructor() {
    effect(() => {
      const el = this.nameInput()?.nativeElement;
      if (el) el.focus();
    });
  }

  protected startAdd(): void {
    this.draft.set('');
    this.date.set(null);
    this.adding.set(true);
  }

  protected cancel(e: Event): void {
    e.stopPropagation();
    this.adding.set(false);
  }

  protected async add(): Promise<void> {
    const name = this.draft().trim();
    if (!name) return;
    const d = this.date();
    this.draft.set('');
    this.date.set(null);
    await this.actions.create(this.ws().id, name, d ? isoFromDate(d) : undefined);
    this.nameInput()?.nativeElement.focus();
  }

  protected drop(e: CdkDragDrop<unknown>): void {
    if (e.previousIndex === e.currentIndex) return;
    const ids = this.milestones().map((m) => m.id);
    moveItemInArray(ids, e.previousIndex, e.currentIndex);
    void this.store.reorderMilestones(this.ws().id, ids);
  }
}
