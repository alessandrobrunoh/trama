import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore, UiStore, usePageShortcuts } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { IssueBoard } from './issue-board';

@Component({
  selector: 'app-issue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, PageHeader, Kbd, TopBarActions, IssueBoard],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (store.can('member')) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New issue</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Issues" />
    <app-issue-board [issues]="store.issues()" [status]="status()" [team]="team()" />
  `,
})
export class IssuePage {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Query `?status=backlog` from attention and saved links. */
  readonly status = input<string>();
  /** Query `?team=<teamId>`. */
  readonly team = input<string>();

  protected readonly plus = LucidePlus;
  private readonly _keys = usePageShortcuts([{ keys: 'c', label: 'New issue', run: () => this.store.can('member') && this.create() }]);

  protected create(): void {
    this.ui.openCreate('issue');
  }
}
