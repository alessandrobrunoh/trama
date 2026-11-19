import {
  DestroyRef,
  Directive,
  Injectable,
  TemplateRef,
  effect,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import type { ActorInput } from '../shared/actor-avatar';

export interface Crumb {
  label: string;
  /** Router link commands. Omit for the current (last) crumb. */
  link?: readonly unknown[];
  /** Render the label in mono (entity keys such as AUTH-42). */
  mono?: boolean;
}

/**
 * Lets a page customise the shell's top bar.
 *  - breadcrumbs: derived from the URL by default; a page can override (e.g. show an issue title)
 *    with `usePageCrumbs(() => [...])`.
 *  - actions: project buttons into the right side of the top bar with
 *      <ng-template appTopBarActions><button hlmBtn size="sm">New</button></ng-template>
 */
export interface PageTitle {
  title: string;
  description?: string;
  /** People involved (assignee, reporter, commenters…): shown as a stacked avatar group after the title. */
  actors?: readonly ActorInput[];
}

@Injectable({ providedIn: 'root' })
export class PageChrome {
  /** null = derive from the URL. */
  readonly crumbs = signal<readonly Crumb[] | null>(null);
  /** Title + description registered by <app-page-header>; the top bar renders them in place of the last crumb. */
  readonly page = signal<PageTitle | null>(null);
  readonly actions = signal<TemplateRef<unknown> | null>(null);
  /** Content of the slim status bar under the main pane (see `<app-status-bar>`). */
  readonly statusBar = signal<TemplateRef<unknown> | null>(null);
  /** Optional replacement for the right pane's tab strip, set by `<ng-template appRightPaneTabs>`. */
  readonly rightPaneTabs = signal<TemplateRef<unknown> | null>(null);
  /** Optional extra icon actions in the right pane header, set by `<ng-template appRightPaneActions>`. */
  readonly rightPaneActions = signal<TemplateRef<unknown> | null>(null);
}

/**
 * Override the breadcrumb trail for the current page (call in an injection context, e.g. a field
 * initializer). Reactive: the callback may read signals. Restores the URL-derived trail on destroy.
 *   private readonly _crumbs = usePageCrumbs(() => [
 *     { label: this.ws()?.key ?? '', mono: true },
 *   ]);
 */
export function usePageCrumbs(build: () => readonly Crumb[]): void {
  const chrome = inject(PageChrome);
  effect(() => chrome.crumbs.set(build()));
  inject(DestroyRef).onDestroy(() => chrome.crumbs.set(null));
}

/**
 * Registers its template as a chrome slot while the host page is alive (the previous owner wins back
 * nothing: slots are cleared only if still ours).
 */
function claimSlot(slot: WritableSignal<TemplateRef<unknown> | null>): void {
  const tpl = inject<TemplateRef<unknown>>(TemplateRef);
  slot.set(tpl);
  inject(DestroyRef).onDestroy(() => {
    if (slot() === tpl) slot.set(null);
  });
}

/** Registers its template as the top bar's action slot while the host page is alive. */
@Directive({ selector: 'ng-template[appTopBarActions]' })
export class TopBarActions {
  constructor() {
    claimSlot(inject(PageChrome).actions);
  }
}

/** Replaces the right pane's tab strip (e.g. `Details | Subtasks | Time`) while the host is alive. */
@Directive({ selector: 'ng-template[appRightPaneTabs]' })
export class RightPaneTabs {
  constructor() {
    claimSlot(inject(PageChrome).rightPaneTabs);
  }
}

/** Adds icon actions at the far right of the right pane header while the host is alive. */
@Directive({ selector: 'ng-template[appRightPaneActions]' })
export class RightPaneActions {
  constructor() {
    claimSlot(inject(PageChrome).rightPaneActions);
  }
}

