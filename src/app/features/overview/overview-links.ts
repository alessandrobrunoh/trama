// What every clickable thing on the Overview does: a single click previews it in the right pane, Enter or a double
// click opens its full page (the same contract as the list pages, see `PreviewLink`).
import { Injectable, inject } from '@angular/core';
import { TramaStore } from '../../core';
import { RightPaneStore, type RightPaneContent } from '../../core/stores/right-pane.store';

export const TONE_VAR = {
  red: 'var(--tone-red)',
  amber: 'var(--tone-amber)',
  green: 'var(--tone-green)',
  neutral: 'var(--muted-foreground)',
} as const;

@Injectable({ providedIn: 'root' })
export class OverviewLinks {
  private readonly store = inject(TramaStore);
  private readonly pane = inject(RightPaneStore);

  /** Router commands of the full page of `target` (for `[appPreviewLink]`). */
  route(target: RightPaneContent): readonly string[] {
    const slug = this.store.slug() ?? '';
    return target.kind === 'task' ? ['/', slug, 'tasks', target.idOrKey] : ['/', slug, 'projects', target.id];
  }

  show(target: RightPaneContent): void {
    this.pane.show(target);
  }

  /** Whether the right pane currently shows `target`. */
  isPreviewed(target: RightPaneContent): boolean {
    const c = this.pane.content();
    if (!c || c.kind !== target.kind) return false;
    if (c.kind === 'project' && target.kind === 'project') return c.id === target.id;
    if (c.kind === 'task' && target.kind === 'task') {
      const a = this.store.getIssue(c.idOrKey);
      const b = this.store.getIssue(target.idOrKey);
      return a !== undefined && a === b;
    }
    return false;
  }
}
