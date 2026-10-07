import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Mono entity key: AUTH-42, BUG-142, ADR-7, a commit sha.
 *   <app-key-chip value="AUTH-42" />      or   <app-key-chip>AUTH-42</app-key-chip>
 */
@Component({
  selector: 'app-key-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'text-muted-foreground inline-flex shrink-0 items-center font-mono text-xs leading-none tracking-tight whitespace-nowrap',
  },
  template: `{{ value() }}<ng-content />`,
})
export class KeyChip {
  readonly value = input<string>('');
}
