import {
  DestroyRef,
  Directive,
  Injectable,
  TemplateRef,
  effect,
  inject,
  signal,
} from '@angular/core';

export interface Crumb {
  label: string;
  /** Router link commands, e.g. ['/', slug, 'workstreams']. Omit for the current (last) crumb. */
  link?: readonly unknown[];
  /** Render the label in mono (entity keys such as AUTH-42). */
  mono?: boolean;
}

/**
 * Lets a page customise the shell's top bar.
 *  - breadcrumbs: derived from the URL by default; a page can override (e.g. show the workstream title)
 *    with `usePageCrumbs(() => [...])`.
 *  - actions: project buttons into the right side of the top bar with
 *      <ng-template appTopBarActions><button hlmBtn size="sm">New</button></ng-template>
 */
@Injectable({ providedIn: 'root' })
export class PageChrome {
  /** null = derive from the URL. */
  readonly crumbs = signal<readonly Crumb[] | null>(null);
  readonly actions = signal<TemplateRef<unknown> | null>(null);
}

/**
 * Override the breadcrumb trail for the current page (call in an injection context, e.g. a field
 * initializer). Reactive: the callback may read signals. Restores the URL-derived trail on destroy.
 *   private readonly _crumbs = usePageCrumbs(() => [
 *     { label: 'Workstreams', link: ['/', this.slug(), 'workstreams'] },
 *     { label: this.ws()?.key ?? '', mono: true },
 *   ]);
 */
export function usePageCrumbs(build: () => readonly Crumb[]): void {
  const chrome = inject(PageChrome);
  effect(() => chrome.crumbs.set(build()));
  inject(DestroyRef).onDestroy(() => chrome.crumbs.set(null));
}

/** Registers its template as the top bar's action slot while the host page is alive. */
@Directive({ selector: 'ng-template[appTopBarActions]' })
export class TopBarActions {
  constructor() {
    const chrome = inject(PageChrome);
    const tpl = inject<TemplateRef<unknown>>(TemplateRef);
    chrome.actions.set(tpl);
    inject(DestroyRef).onDestroy(() => {
      if (chrome.actions() === tpl) chrome.actions.set(null);
    });
  }
}

