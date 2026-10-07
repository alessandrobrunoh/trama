// PLACEHOLDER — replace with the real screen (keep the class name and route inputs).
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-intake-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-placeholder style="padding: 16px">
      <h1>Intake</h1>
      <div>workspaceSlug: {{ workspaceSlug() }}</div>
    </div>
  `,
})
export class IntakePage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
}
