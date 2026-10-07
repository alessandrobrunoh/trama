import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import {
  LucideBug,
  LucideDynamicIcon,
  LucideFlame,
  LucideLightbulb,
  LucideMessageSquare,
  LucideShieldAlert,
  LucideSparkles,
  LucideWrench,
  type LucideIcon,
} from '@lucide/angular';
import type { IntakeKind } from '../core/contracts/domain';

const KIND: Record<IntakeKind, { label: string; icon: LucideIcon; color: string }> = {
  bug: { label: 'Bug', icon: LucideBug, color: 'text-tone-red' },
  feature: { label: 'Feature', icon: LucideSparkles, color: 'text-tone-blue' },
  incident: { label: 'Incident', icon: LucideFlame, color: 'text-tone-orange' },
  tech_debt: { label: 'Tech debt', icon: LucideWrench, color: 'text-tone-slate' },
  feedback: { label: 'Feedback', icon: LucideMessageSquare, color: 'text-tone-teal' },
  idea: { label: 'Idea', icon: LucideLightbulb, color: 'text-tone-amber' },
  security: { label: 'Security', icon: LucideShieldAlert, color: 'text-tone-violet' },
};

/** Intake kind glyph (+ optional label). `<app-intake-kind [kind]="item.kind" showLabel />` */
@Component({
  selector: 'app-intake-kind',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'inline-flex items-center gap-1.5 whitespace-nowrap' },
  template: `
    <svg [class]="v().color" [lucideIcon]="v().icon" [size]="size()" [strokeWidth]="1.75"></svg>
    @if (showLabel()) {
      <span>{{ v().label }}</span>
    }
  `,
})
export class IntakeKindLabel {
  readonly kind = input.required<IntakeKind>();
  readonly size = input(14);
  readonly showLabel = input(false, { transform: booleanAttribute });
  protected readonly v = computed(() => KIND[this.kind()]);
}
