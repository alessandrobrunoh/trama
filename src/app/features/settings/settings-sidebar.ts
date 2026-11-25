import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideDynamicIcon, LucideTriangleAlert } from '@lucide/angular';
import { filter, map, startWith } from 'rxjs';
import { TramaStore } from '../../core/stores/trama.store';
import { SETTINGS_GROUPS, settingsSectionOfUrl } from './settings-nav';

/**
 * The settings sidebar (v3 "Settings sidebar", 248px): it replaces the main sidebar while a settings page
 * is open. Window squares, "Back to Trama" (esc), the title, WORKSPACE and ACCOUNT groups, and the
 * danger zone pinned to the bottom. Mounted by `AppSidebar` in place of its own content.
 */
@Component({
  selector: 'app-settings-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon],
  host: {
    class: 'flex h-full min-h-0 flex-col',
    '(document:keydown.escape)': 'onEscape($event)',
  },
  template: `
    <div class="flex items-center gap-2 px-3.5 pt-3.5 pb-2.5" aria-hidden="true">
      <span class="flex gap-1.5">
        <span class="bg-line size-[9px]"></span>
        <span class="bg-line size-[9px]"></span>
        <span class="bg-line size-[9px]"></span>
      </span>
    </div>

    <div class="px-2 pt-0.5 pb-1.5">
      <a
        [routerLink]="backLink()"
        class="bg-background border-border text-foreground hover:border-border-strong focus-visible:ring-sidebar-ring flex h-8 items-center gap-2 border px-2.5 text-[13px] outline-hidden focus-visible:ring-2"
      >
        <svg [lucideIcon]="back" [size]="14" class="text-muted-foreground shrink-0"></svg>
        Back to Trama
        <span class="flex-1"></span>
        <kbd class="bg-secondary border-border text-muted-foreground border px-[5px] py-px font-mono text-[10.5px] leading-[14px]">esc</kbd>
      </a>
    </div>

    <div class="flex flex-col gap-0.5 px-[18px] pt-3.5 pb-2">
      <span class="font-title text-foreground text-[24px] leading-normal">Settings</span>
      <span class="text-faint truncate font-mono text-[10px] leading-[13px]">{{ workspaceName() }} workspace</span>
    </div>

    <nav class="scrollbar-none min-h-0 flex-1 overflow-y-auto" aria-label="Settings sections">
      @for (g of groups; track g.title) {
        <div class="flex flex-col gap-px p-2">
          <span class="text-faint font-mono text-[10px] leading-[13px]">{{ g.title }}</span>
          @for (s of g.sections; track s.id) {
            <a
              [routerLink]="['/', slug(), 'settings', s.id]"
              class="focus-visible:ring-sidebar-ring flex h-[30px] items-center gap-2.5 px-2.5 text-[13px] outline-hidden focus-visible:ring-2"
              [class]="current() === s.id ? 'bg-hover text-foreground' : 'text-muted-foreground hover:bg-hover/60 hover:text-foreground'"
              [attr.aria-current]="current() === s.id ? 'page' : null"
            >
              <svg [lucideIcon]="s.icon" [size]="15" class="shrink-0"></svg>
              <span class="truncate">{{ s.label }}</span>
            </a>
          }
        </div>
      }
    </nav>

    <div class="border-border border-t p-2">
      <a
        [routerLink]="['/', slug(), 'settings', 'workspace']"
        class="text-red hover:bg-hover/60 focus-visible:ring-sidebar-ring flex h-[30px] items-center gap-2.5 px-2.5 text-[13px] outline-hidden focus-visible:ring-2"
        title="Delete the workspace: at the bottom of General"
      >
        <svg [lucideIcon]="warn" [size]="15" class="shrink-0"></svg>
        Danger zone
      </a>
    </div>
  `,
})
export class SettingsSidebar {
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  protected readonly groups = SETTINGS_GROUPS;
  protected readonly back = LucideArrowLeft;
  protected readonly warn = LucideTriangleAlert;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly workspaceName = computed(() => this.store.slug() ?? this.store.workspace()?.name ?? '');
  protected readonly backLink = computed(() => ['/', this.slug(), 'overview']);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  protected readonly current = computed(() => settingsSectionOfUrl(this.url()));

  /** Esc leaves settings, unless it is closing something (a dialog, a menu) or the person is typing. */
  protected onEscape(event: Event): void {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (typeof target?.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (this.document.querySelector('.cdk-overlay-pane, [role="dialog"], [role="menu"], [role="listbox"]')) return;
    void this.router.navigate(this.backLink());
  }
}
