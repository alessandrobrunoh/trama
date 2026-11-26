import type { BooleanInput, NumberInput } from '@angular/cdk/coercion';
import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  numberAttribute,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideInfo,
  lucideLoader2,
  lucideOctagonX,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { BrnSonnerImports, type ToasterProps } from '@spartan-ng/brain/sonner';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { hlm } from '@spartan-ng/helm/utils';
import type { ClassValue } from 'clsx';

@Component({
  selector: 'hlm-toaster',
  imports: [BrnSonnerImports, HlmButtonImports, NgIcon],
  providers: [
    provideIcons({
      lucideCircleCheck,
      lucideInfo,
      lucideTriangleAlert,
      lucideOctagonX,
      lucideLoader2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <brn-sonner-toaster
      [class]="_computedClass()"
      [invert]="invert()"
      [theme]="theme()"
      [position]="position()"
      [hotKey]="hotKey()"
      [richColors]="richColors()"
      [expand]="expand()"
      [duration]="duration()"
      [visibleToasts]="visibleToasts()"
      [closeButton]="closeButton()"
      [toastOptions]="_computedToastOptions()"
      [offset]="offset()"
      [style]="userStyle()"
    >
      <!-- v3 · 18: 14px status icon (blue link / red trash / yellow warning in the frame) -->
      <ng-template #loadingIcon>
        <ng-icon
          name="lucideLoader2"
          class="text-muted-foreground overflow-visible! text-[14px] [&>svg]:motion-safe:animate-spin"
        />
      </ng-template>
      <ng-template #successIcon>
        <ng-icon name="lucideCircleCheck" class="text-green overflow-visible! text-[14px]" />
      </ng-template>
      <ng-template #errorIcon>
        <ng-icon name="lucideOctagonX" class="text-red overflow-visible! text-[14px]" />
      </ng-template>
      <ng-template #infoIcon>
        <ng-icon name="lucideInfo" class="text-delta overflow-visible! text-[14px]" />
      </ng-template>
      <ng-template #warningIcon>
        <ng-icon name="lucideTriangleAlert" class="text-yellow overflow-visible! text-[14px]" />
      </ng-template>
      <button
        *brnToastAction="let action; let toast = toast"
        [style]="toast.actionButtonStyle"
        hlmBtn
        variant="ghost"
        size="sm"
        class="text-foreground! ml-auto h-auto! shrink-0 bg-transparent! px-0! py-0! font-mono text-[11px]! hover:bg-transparent! hover:underline"
        (click)="action.onClick($event)"
      >
        {{ action.label }}
      </button>
      <button
        *brnToastCancelAction="let cancel; let toast = toast"
        [style]="toast.cancelButtonStyle"
        hlmBtn
        size="sm"
        variant="secondary"
        (click)="cancel.onClick($event)"
      >
        {{ cancel.label }}
      </button>
    </brn-sonner-toaster>
  `,
})
export class HlmToaster {
  public readonly invert = input<ToasterProps['invert'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly theme = input<ToasterProps['theme']>('light');
  public readonly position = input<ToasterProps['position']>('bottom-right');
  public readonly hotKey = input<ToasterProps['hotkey']>(['altKey', 'KeyT']);
  public readonly richColors = input<ToasterProps['richColors'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly expand = input<ToasterProps['expand'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly duration = input<ToasterProps['duration'], NumberInput>(4000, {
    transform: numberAttribute,
  });
  public readonly visibleToasts = input<ToasterProps['visibleToasts'], NumberInput>(3, {
    transform: numberAttribute,
  });
  public readonly closeButton = input<ToasterProps['closeButton'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly toastOptions = input<ToasterProps['toastOptions']>({});

  protected readonly _computedToastOptions = computed(() => {
    const options = this.toastOptions();
    return {
      ...options,
      classes: {
        ...options?.classes,
        // v3 Toast: 37px, padding 10 12, gap 10, raised fill + hairline, Sans 13, shadow 0 8 24.
        toast: hlm(
          'bg-secondary! border-border! shadow-toast! gap-2.5! rounded-none! p-[10px_12px]! text-[13px]!',
          options?.classes?.toast,
        ),
        title: hlm('text-[13px]! leading-[17px]! font-normal!', options?.classes?.title),
        description: hlm('text-muted-foreground! text-xs!', options?.classes?.description),
      },
    };
  });
  public readonly offset = input<ToasterProps['offset']>(null);
  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  public readonly userStyle = input<Record<string, string>>(
    {
      '--normal-bg': 'var(--secondary)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
      '--width': '380px',
      '--offset': '20px',
      // v3 · 18: the stack sits 72px above the bottom edge, clear of the status bar.
      bottom: '72px',
    },
    { alias: 'style' },
  );

  protected readonly _computedClass = computed(() => hlm('toaster group', this.userClass()));
}
