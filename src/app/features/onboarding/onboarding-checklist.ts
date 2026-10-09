import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideCheck, LucideChevronDown, LucideDynamicIcon, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore } from '../../core/stores/trama.store';
import { OnboardingStore, type OnboardingStep } from '../../core/stores/onboarding.store';
import { UiStore } from '../../core/stores/ui.store';

/**
 * "Get started" card for workspaces that are still being set up: six steps from the first team to a connected
 * agent. Done steps come from real data (see OnboardingStore). Dismissible; the help menu brings it back.
 */
@Component({
  selector: 'app-onboarding-checklist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    @if (onboarding.visible() && compact() && !expanded()) {
      <section class="bg-card flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-4 py-2" aria-label="Setup checklist">
        <div
          class="bg-muted h-1 w-16 shrink-0 overflow-hidden rounded-full max-sm:hidden"
          role="progressbar"
          aria-label="Setup progress"
          [attr.aria-valuenow]="onboarding.doneCount()"
          aria-valuemin="0"
          [attr.aria-valuemax]="onboarding.total()"
        >
          <div class="bg-primary h-full rounded-full" [style.width.%]="percent()"></div>
        </div>
        <p class="min-w-0 flex-1 text-[13px]">
          <span class="font-medium">{{ onboarding.complete() ? 'You are all set' : 'Get started' }}</span>
          <span class="text-muted-foreground ms-2 tabular-nums">{{ onboarding.doneCount() }}/{{ onboarding.total() }}</span>
          @if (onboarding.next(); as next) {
            <span class="text-muted-foreground ms-2 max-sm:hidden">Next: {{ next.title }}</span>
          }
        </p>
        @if (onboarding.next(); as next) {
          <button type="button" hlmBtn size="sm" class="h-7 px-2.5 text-xs" (click)="run(next)">{{ next.cta }}</button>
        }
        <button type="button" hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 px-2 text-xs" (click)="expanded.set(true)">
          All steps
          <svg [lucideIcon]="moreIcon" [size]="12"></svg>
        </button>
        <button type="button" hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-7" aria-label="Dismiss the setup checklist" title="Dismiss. You can bring it back from the help menu." (click)="onboarding.dismiss()">
          <svg [lucideIcon]="closeIcon" [size]="14"></svg>
        </button>
      </section>
    } @else if (onboarding.visible()) {
      <section class="bg-card rounded-lg border" aria-labelledby="onboarding-title">
        <header class="flex items-start gap-3 px-4 pt-4 pb-3 sm:px-5">
          <div class="min-w-0 flex-1">
            <h2 id="onboarding-title" class="text-[15px] font-semibold tracking-tight">
              @if (onboarding.complete()) { You are all set } @else { Get started with Trama }
            </h2>
            <p class="text-muted-foreground mt-0.5 text-[13px] leading-snug">
              @if (onboarding.complete()) {
                Everything is connected. Dismiss this card whenever you like.
              } @else {
                {{ onboarding.doneCount() }} of {{ onboarding.total() }} done. Each step takes about a minute.
              }
            </p>
          </div>
          <button
            type="button"
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground -me-1 -mt-1 size-7 shrink-0"
            aria-label="Dismiss the setup checklist"
            title="Dismiss. You can bring it back from the help menu."
            (click)="onboarding.dismiss()"
          >
            <svg [lucideIcon]="closeIcon" [size]="14"></svg>
          </button>
        </header>

        <div
          class="bg-muted mx-4 h-1 overflow-hidden rounded-full sm:mx-5"
          role="progressbar"
          aria-label="Setup progress"
          [attr.aria-valuenow]="onboarding.doneCount()"
          aria-valuemin="0"
          [attr.aria-valuemax]="onboarding.total()"
        >
          <div class="bg-primary h-full rounded-full transition-[width] duration-300" [style.width.%]="percent()"></div>
        </div>

        <ol class="mt-2 pb-2">
          @for (step of onboarding.steps(); track step.id) {
            <li class="flex items-start gap-3 px-4 py-2 sm:px-5" [class.bg-muted/40]="onboarding.next()?.id === step.id">
              <span
                class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border"
                [class.bg-primary]="step.done"
                [class.border-primary]="step.done"
                [class.text-primary-foreground]="step.done"
                aria-hidden="true"
              >
                @if (step.done) {
                  <svg [lucideIcon]="checkIcon" [size]="12" [strokeWidth]="3"></svg>
                }
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-[13px] font-medium" [class.text-muted-foreground]="step.done" [class.line-through]="step.done">
                  {{ step.title }}
                  @if (step.done) { <span class="sr-only">(done)</span> }
                </p>
                @if (!step.done) {
                  <p class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ step.description }}</p>
                }
              </div>
              @if (!step.done) {
                <button
                  type="button"
                  hlmBtn
                  size="sm"
                  [variant]="onboarding.next()?.id === step.id ? 'default' : 'outline'"
                  class="h-7 shrink-0 px-2.5 text-xs"
                  (click)="run(step)"
                >
                  {{ step.cta }}
                </button>
              }
            </li>
          }
        </ol>
      </section>
    }
  `,
})
export class OnboardingChecklist {
  protected readonly onboarding = inject(OnboardingStore);
  private readonly ui = inject(UiStore);
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);

  /** A one-line bar (the Inbox) instead of the full card; "All steps" opens the card. */
  readonly compact = input(false, { transform: booleanAttribute });
  protected readonly expanded = signal(false);
  protected readonly moreIcon = LucideChevronDown;
  protected readonly checkIcon = LucideCheck;
  protected readonly closeIcon = LucideX;
  protected readonly percent = computed(() =>
    this.onboarding.total() ? (this.onboarding.doneCount() / this.onboarding.total()) * 100 : 0,
  );

  protected run(step: OnboardingStep): void {
    const action = step.action;
    switch (action.kind) {
      case 'create':
        this.ui.openCreate(action.what);
        break;
      case 'command-bar':
        this.ui.openCommandPalette();
        break;
      case 'link':
        void this.router.navigate(['/', this.store.slug(), ...action.path]);
        break;
    }
  }
}
