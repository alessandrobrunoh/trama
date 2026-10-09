// Acceptance criteria checklist: click the glyph to cycle ○ pending → ● in progress → ✓ met,
// click the text to edit, add / remove inline.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideCircle, LucideCircleCheck, LucideCircleDot, LucideDynamicIcon, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { CRITERION_STATE_META, NablaStore, type AcceptanceCriterion, type CriterionState, type Workstream } from '../../core';
import { CriterionEvidence } from './criterion-evidence';
import { InlineText } from './inline-edit';

const NEXT: Record<CriterionState, CriterionState> = { pending: 'in_progress', in_progress: 'met', met: 'pending' };

@Component({
  selector: 'app-criteria-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmTooltip, LucideDynamicIcon, InlineText, CriterionEvidence],
  host: { class: 'block' },
  template: `
    <div class="mb-2 flex items-center gap-2">
      <h2 class="text-sm font-semibold">Acceptance criteria</h2>
      @if (ws().acceptanceCriteria.length) {
        <span class="text-muted-foreground text-xs tabular-nums">{{ met() }}/{{ ws().acceptanceCriteria.length }} met</span>
        <span class="bg-muted flex h-1 w-20 overflow-hidden rounded-full">
          <span class="bg-status-shipped h-full" [style.width.%]="pct()"></span>
        </span>
      }
    </div>
    <ul class="flex flex-col">
      @for (c of ws().acceptanceCriteria; track c.id) {
        <li class="group hover:bg-hover -mx-1.5 rounded-md px-1.5">
          <div class="flex items-center gap-1">
          <button
            type="button"
            class="hover:bg-accent focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none"
            [disabled]="!canEdit()"
            [hlmTooltip]="meta[c.state].label + ' — click to change'"
            position="left"
            [attr.aria-label]="'Criterion ' + meta[c.state].label + ': ' + c.text"
            (click)="cycle(c)"
          >
            @switch (c.state) {
              @case ('met') {
                <svg [lucideIcon]="doneIcon" [size]="17" class="text-status-shipped"></svg>
              }
              @case ('in_progress') {
                <svg [lucideIcon]="dotIcon" [size]="17" class="text-status-working"></svg>
              }
              @default {
                <svg [lucideIcon]="circleIcon" [size]="17" class="text-muted-foreground"></svg>
              }
            }
          </button>
          <app-inline-text
            class="min-w-0 flex-1"
            label="criterion"
            [value]="c.text"
            [canEdit]="canEdit()"
            [textClass]="'text-sm ' + (c.state === 'met' ? 'text-muted-foreground line-through decoration-muted-foreground/40' : '')"
            (save)="rename(c, $event)"
          />
          @if (canEdit()) {
            <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100" aria-label="Remove criterion" (click)="remove(c)">
              <svg [lucideIcon]="xIcon" [size]="13"></svg>
            </button>
          }
          </div>
          @if (c.state === 'met' || c.evidence) {
            <app-criterion-evidence class="mb-1 pl-9" [ws]="ws()" [c]="c" />
          }
        </li>
      } @empty {
        <li class="text-muted-foreground py-1 text-sm">No acceptance criteria yet. Define what “done” means.</li>
      }
    </ul>
    @if (canEdit()) {
      <div class="mt-1.5 flex items-center gap-1.5">
        <svg [lucideIcon]="plusIcon" [size]="15" class="text-muted-foreground mx-[7px] shrink-0"></svg>
        <input
          hlmInput
          class="h-8 flex-1 border-transparent bg-transparent shadow-none focus-visible:border-input"
          placeholder="Add a criterion…"
          aria-label="New acceptance criterion"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown.enter)="add()"
        />
      </div>
    }
  `,
})
export class CriteriaList {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly draft = signal('');
  protected readonly meta = CRITERION_STATE_META;
  protected readonly doneIcon = LucideCircleCheck;
  protected readonly dotIcon = LucideCircleDot;
  protected readonly circleIcon = LucideCircle;
  protected readonly plusIcon = LucidePlus;
  protected readonly xIcon = LucideX;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly met = computed(() => this.ws().acceptanceCriteria.filter((c) => c.state === 'met').length);
  protected readonly pct = computed(() => {
    const n = this.ws().acceptanceCriteria.length;
    return n ? (this.met() / n) * 100 : 0;
  });

  protected cycle(c: AcceptanceCriterion): void {
    void this.store.updateCriterion(this.ws().id, c.id, { state: NEXT[c.state] });
  }
  protected rename(c: AcceptanceCriterion, text: string): void {
    void this.store.updateCriterion(this.ws().id, c.id, { text });
  }
  protected remove(c: AcceptanceCriterion): void {
    void this.store.removeCriterion(this.ws().id, c.id);
  }
  protected async add(): Promise<void> {
    const text = this.draft().trim();
    if (!text) return;
    this.draft.set('');
    await this.store.addCriterion(this.ws().id, { text });
  }
}
