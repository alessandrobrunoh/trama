import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon, LucideTriangle } from '@lucide/angular';
import { ESTIMATE_SCALES, type EstimateScale } from '../../../core/contracts/domain';
import { ESTIMATE_SCALE_DEFS, ESTIMATE_SCALE_ORDER, type EstimateOption } from '../../../core/estimates';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { SECTION_KIT } from './section-kit';

/**
 * Settings · Estimates (v4 frame 07): the scale every project in the workspace counts in. Estimates are
 * stored as numbers, so switching scale never rewrites a task: a value that is not on the new scale stays
 * visible and selectable. A choice is saved at once. The preview is the picker people get on a task.
 */
@Component({
  selector: 'app-estimates-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Estimates"
      description="How big is a task? Pick one scale for the whole workspace. Switching never rewrites a task."
    />

    @if (!canAdmin()) {
      <app-readonly-note class="mb-0!">Only admins and owners can change the estimate scale.</app-readonly-note>
    }

    <div class="flex flex-col gap-8 lg:flex-row">
      <div class="bg-card border-border min-w-0 flex-1 self-start border" role="radiogroup" aria-label="Estimate scale">
        @for (d of scaleDefs; track d.id) {
          <button
            type="button"
            role="radio"
            class="focus-visible:ring-ring/50 flex w-full items-center gap-3.5 px-3.5 py-3 text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed"
            [class]="
              scale() === d.id
                ? 'bg-primary/10 outline-primary/40 relative outline -outline-offset-1'
                : 'border-border enabled:hover:bg-hover/40 border-t first:border-t-0'
            "
            [attr.aria-checked]="scale() === d.id"
            [disabled]="!canAdmin() || savingScale()"
            (click)="setScale(d.id)"
          >
            <span
              class="bg-background flex size-4 shrink-0 items-center justify-center border"
              [class]="scale() === d.id ? 'border-primary' : 'border-border-strong'"
              aria-hidden="true"
            >
              @if (scale() === d.id) {
                <span class="bg-primary size-2"></span>
              }
            </span>
            <span class="flex w-[110px] shrink-0 flex-col gap-0.5 sm:w-[150px]">
              <span class="text-foreground text-[13.5px] leading-[normal]">{{ d.label }}</span>
              <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ d.sub }}</span>
            </span>
            <span class="flex min-w-0 flex-1 flex-wrap gap-1">
              @if (d.options.length) {
                @for (o of d.options; track o.value) {
                  <span
                    class="border-border flex min-w-[30px] items-start justify-center border px-1 py-[3px] font-mono text-[11.5px] leading-[normal]"
                    [class]="scale() === d.id ? 'bg-secondary text-foreground' : 'text-muted-foreground'"
                    >{{ o.label }}</span
                  >
                }
              } @else {
                <span class="text-muted-foreground text-[12.5px]">Tasks have no estimate field.</span>
              }
            </span>
          </button>
        }
      </div>

      <div class="flex w-full shrink-0 flex-col gap-2.5 lg:w-[280px]">
        <span class="text-faint font-mono text-[10.5px] leading-[normal]">PREVIEW · ESTIMATE PICKER</span>
        @if (options().length) {
          <div class="bg-popover border-border-strong border" aria-hidden="true">
            <div class="border-border flex items-center gap-2 border-b px-2.5 py-[9px]">
              <svg [lucideIcon]="triangle" [size]="14" class="text-muted-foreground shrink-0"></svg>
              <span class="text-faint text-[13px] leading-[normal]">Set estimate…</span>
            </div>
            <div class="flex flex-col py-1">
              <div class="flex items-center px-2.5 py-1.5">
                <span class="text-foreground flex-1 text-[13px] leading-[normal]">No estimate</span>
                <span class="text-faint font-mono text-[10.5px] leading-[normal]">0</span>
              </div>
              @for (o of options(); track o.value; let i = $index) {
                <div class="flex items-center px-2.5 py-1.5" [class.bg-selected]="i === highlighted()">
                  <span class="text-foreground flex-1 text-[13px] leading-[normal]">{{ optionText(o) }}</span>
                  <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ i + 1 }}</span>
                </div>
              }
            </div>
          </div>
          <span class="text-faint font-mono text-[10.5px] leading-[normal]">Shortcut&nbsp;&nbsp;E&nbsp;&nbsp;on any task</span>
        } @else {
          <p class="text-muted-foreground text-[12.5px] leading-[19px]">
            With this scale a task has no estimate field. Values already set are kept and come back if you pick a scale again.
          </p>
        }
      </div>
    </div>
  `,
})
export class EstimatesSection {
  private readonly store = inject(TramaStore);
  private readonly notify = inject(Notifier);

  protected readonly triangle = LucideTriangle;
  protected readonly savingScale = signal(false);
  protected readonly scale = computed(() => this.store.estimateScale());
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly scaleDefs = ESTIMATE_SCALE_ORDER.filter((s) => ESTIMATE_SCALES.includes(s)).map((id) => {
    const def = ESTIMATE_SCALE_DEFS[id];
    return {
      id,
      label: def.label,
      options: def.options,
      sub: id === 'none' ? 'off' : `${def.options.length} values`,
    };
  });
  /** The values of the current scale, as the picker offers them. */
  protected readonly options = computed(() => ESTIMATE_SCALE_DEFS[this.scale()]?.options ?? []);
  /** Which row the preview paints as hovered: the middle of the list, like the frame. */
  protected readonly highlighted = computed(() => Math.min(3, Math.max(0, this.options().length - 1)));

  protected optionText(o: EstimateOption): string {
    if (this.scale() === 'tshirt') return o.label;
    return `${o.label} ${o.value === 1 ? 'point' : 'points'}`;
  }

  /** Saves immediately (a radio choice, not a form field). */
  protected async setScale(scale: EstimateScale): Promise<void> {
    if (!this.canAdmin() || scale === this.scale() || this.savingScale()) return;
    this.savingScale.set(true);
    const ok = await this.store.updateSettings({ estimateScale: scale });
    this.savingScale.set(false);
    if (ok) {
      this.notify.success(`Estimates: ${ESTIMATE_SCALE_DEFS[scale].label}`, {
        description: scale === 'none' ? 'Estimates are hidden; existing values are kept.' : 'Existing estimates keep their value.',
      });
    }
  }
}
