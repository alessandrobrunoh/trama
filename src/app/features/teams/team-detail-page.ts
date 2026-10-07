// PLACEHOLDER — replace with the real screen (keep the class name and route inputs).
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-team-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-placeholder style="padding: 16px">
      <h1>Team</h1>
      <div>workspaceSlug: {{ workspaceSlug() }}</div>
      <div>key: {{ key() }}</div>
    </div>
  `,
})
export class TeamDetailPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly key = input<string>();
}
