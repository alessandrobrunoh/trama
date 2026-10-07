// PLACEHOLDER — replace with the real screen (keep the class name and route inputs).
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-view-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-placeholder style="padding: 16px">
      <h1>View</h1>
      <div>workspaceSlug: {{ workspaceSlug() }}</div>
      <div>id: {{ id() }}</div>
    </div>
  `,
})
export class ViewDetailPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();
}
