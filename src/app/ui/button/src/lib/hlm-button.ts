import { Directive, input, signal } from '@angular/core';
import { BrnButton } from '@spartan-ng/brain/button';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ClassValue } from 'clsx';
import { injectBrnButtonConfig } from './hlm-button.token';

export const buttonVariants = cva(
  "focus-visible:border-ring focus-visible:ring-ring/50 data-[matches-spartan-invalid=true]:ring-destructive/20 dark:data-[matches-spartan-invalid=true]:ring-destructive/40 data-[matches-spartan-invalid=true]:border-destructive dark:data-[matches-spartan-invalid=true]:border-destructive/50 rounded-none border border-transparent bg-clip-padding font-mono text-[12px] font-normal focus-visible:ring-2 data-[matches-spartan-invalid=true]:ring-3 [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)] group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] outline-none select-none motion-safe:active:translate-y-px data-disabled:pointer-events-none data-disabled:opacity-50 [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0",
  {
    variants: {
      variant: {
        // v3: red fill, white mono label (Btn / Primary)
        default:
          'bg-primary text-primary-foreground hover:bg-primary/88 [&_kbd]:bg-white/15 [&_kbd]:text-white [&_kbd]:border-transparent',
        // v3: raised fill + hairline (Btn / Secondary)
        outline:
          'border-border bg-secondary text-foreground hover:bg-accent aria-expanded:bg-accent aria-expanded:text-foreground [&_kbd]:bg-background [&_kbd]:border-transparent',
        secondary:
          'border-border bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent aria-expanded:text-secondary-foreground [&_kbd]:bg-background [&_kbd]:border-transparent',
        // v3: muted mono label, no frame (Btn / Ghost)
        ghost:
          'text-muted-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-selected aria-expanded:text-foreground',
        // v3: red hairline + red label (Btn / Danger)
        destructive:
          'border-destructive text-destructive bg-transparent hover:bg-destructive/12 focus-visible:ring-destructive/30 [&_kbd]:bg-destructive/15 [&_kbd]:text-destructive [&_kbd]:border-transparent',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // v3 buttons: 5px / 10px padding, 6px end padding when a key cap closes the label
        default:
          'h-7 gap-2 px-2.5 has-[kbd]:pe-1.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(3)]",
        sm: "h-7 gap-2 rounded-[min(var(--radius-md),12px)] px-2.5 has-[kbd]:pe-1.5 text-[12px] in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(3.5)]",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-3 has-data-[icon=inline-start]:ps-3',
        icon: 'size-8',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(3)]",
        'icon-sm':
          'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-md',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

@Directive({
  selector: 'button[hlmBtn], a[hlmBtn]',
  exportAs: 'hlmBtn',
  hostDirectives: [{ directive: BrnButton, inputs: ['disabled'] }],
  host: { 'data-slot': 'button', '[attr.data-variant]': 'variant()' },
})
export class HlmButton {
  private readonly _config = injectBrnButtonConfig();

  private readonly _additionalClasses = signal<ClassValue>('');

  public readonly variant = input<ButtonVariants['variant']>(this._config.variant);

  public readonly size = input<ButtonVariants['size']>(this._config.size);

  constructor() {
    classes(() => [
      buttonVariants({ variant: this.variant(), size: this.size() }),
      this._additionalClasses(),
    ]);
  }

  setClass(classes: string): void {
    this._additionalClasses.set(classes);
  }
}
