// PLACEHOLDER — replace with the real screen (keep the class name and route inputs).
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-issue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-placeholder style="padding: 16px">
      <h1>Issues</h1>
      <div>workspaceSlug: {{ workspaceSlug() }}</div>
    </div>
  `,
})
export class IssuePage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
}
