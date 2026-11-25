import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ESTIMATE_SCALES, type EstimateScale } from '../../../core/contracts/domain';
import { ESTIMATE_SCALE_DEFS, ESTIMATE_SCALE_ORDER } from '../../../core/estimates';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { SECTION_KIT } from './section-kit';

/**
 * Settings · Estimates (v3 frame 29): the scale every project in the workspace counts in. Estimates are
 * stored as numbers, so switching scale never rewrites a task: a value that is not on the new scale stays
 * visible and selectable. A choice is saved at once.
 */
@Component({
  selector: 'app-estimates-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [...SECTION_KIT],
  host: { class: 'flex flex-col' },
  template: `
    <app-section-header
      title="Estimates"
      description="An estimate is a number, not hours. Pick the scale your team counts in. Switching scale never rewrites a task: a value that is not on the new scale stays visible and selectable."
    />

    @if (!canAdmin()) {
      <app-readonly-note>Only admins and owners can change the estimate scale.</app-readonly-note>
    }

    <app-settings-section title="Scale" [caption]="'used by every project in ' + workspaceName()">
      <div class="flex max-w-[720px] flex-col gap-2.5 pt-2.5" role="radiogroup" aria-label="Estimate scale">
        @for (d of scaleDefs; track d.id) {
          <button
            type="button"
            role="radio"
            class="focus-visible:ring-ring/50 flex w-full items-center gap-3.5 border px-3.5 py-3 text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed"
            [class]="
              scale() === d.id
                ? 'bg-primary/10 border-primary border-l-2'
                : 'bg-background border-border enabled:hover:border-border-strong'
            "
            [attr.aria-checked]="scale() === d.id"
            [disabled]="!canAdmin() || savingScale()"
            (click)="setScale(d.id)"
          >
            <span
              class="size-[14px] shrink-0 rounded-full border-[1.5px]"
              [class]="scale() === d.id ? 'border-primary border-[4px]' : 'border-faint'"
              aria-hidden="true"
            ></span>
            <span class="flex w-[130px] shrink-0 flex-col gap-[3px] sm:w-[180px]">
              <span class="text-foreground text-[14px] leading-none" [class.font-semibold]="scale() === d.id">{{ d.label }}</span>
              <span class="text-faint text-[11.5px] leading-snug">{{ d.hint }}</span>
            </span>
            <span class="min-w-0 flex-1 font-mono text-[13px] tracking-[1px]" [class]="scale() === d.id ? 'text-foreground' : 'text-muted-foreground'">
              @if (d.values) {
                {{ d.values }}
              } @else {
                <span class="text-faint text-[12px] tracking-normal italic">No estimate field</span>
              }
            </span>
            @if (scale() === d.id) {
              <span class="bg-secondary text-faint px-2 py-[3px] font-mono text-[10px] leading-[13px]">current</span>
            }
          </button>
        }
      </div>
    </app-settings-section>
  `,
})
export class EstimatesSection {
  private readonly store = inject(TramaStore);
  private readonly notify = inject(Notifier);

  protected readonly savingScale = signal(false);
  protected readonly scale = computed(() => this.store.estimateScale());
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly workspaceName = computed(() => this.store.slug() ?? 'this workspace');
  protected readonly scaleDefs = ESTIMATE_SCALE_ORDER.filter((s) => ESTIMATE_SCALES.includes(s)).map((id) => {
    const def = ESTIMATE_SCALE_DEFS[id];
    return {
      id,
      label: def.label,
      hint: def.description.split('. ')[0].replace(/\.$/, ''),
      values: def.options.map((o) => o.label).join(' '),
    };
  });

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
