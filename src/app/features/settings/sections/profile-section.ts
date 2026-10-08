import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { LucideDynamicIcon, LucideLogOut, LucidePlus } from '@lucide/angular';
import { SessionStore } from '../../../core/session/session.store';
import { NablaStore } from '../../../core/stores/nabla.store';
import { ROLE_META } from '../../../core/meta';
import { Clipboard } from '../../../core/notify/notifier';
import { avatarColor } from '../../../core/utils';
import type { Role, Workspace } from '../../../core/contracts/domain';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { FullDatePipe } from '../../../shared/pipes';
import { SECTION_KIT } from './section-kit';

/** Your account: identity (set at sign-up, read-only), workspaces you belong to, sign out. */
@Component({
  selector: 'app-profile-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, ActorAvatar, LucideDynamicIcon, FullDatePipe, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header title="Profile" description="How you appear to teammates and agents across Nabla." />

      <div class="mb-8 flex items-center gap-4">
        <app-actor-avatar [actor]="meRef()" [size]="56" />
        <div class="min-w-0">
          <div class="truncate text-base font-semibold">{{ user()?.name }}</div>
          <div class="text-muted-foreground truncate text-[13px]">{{ user()?.email }}</div>
          @if (roleLabel(); as r) {
            <div class="text-muted-foreground mt-0.5 text-xs">{{ r }} in {{ store.workspace()?.name }}</div>
          }
        </div>
      </div>

      <app-settings-group title="Account" description="Your name and email come from sign-up and identify you on comments, decisions and assignments.">
        <app-settings-row label="Full name">
          <span class="text-[13px]">{{ user()?.name }}</span>
        </app-settings-row>
        <app-settings-row label="Email" description="Used to sign in and to be added to workspaces.">
          <button type="button" class="hover:text-foreground text-muted-foreground font-mono text-xs" title="Copy email" (click)="copyEmail()">{{ user()?.email }}</button>
        </app-settings-row>
        <app-settings-row label="Avatar colour" description="Derived from your account, so it looks the same everywhere.">
          <span class="flex items-center gap-2">
            <span class="ring-border size-5 rounded-full ring-1" [style.background]="hueColor()"></span>
            <span class="text-muted-foreground font-mono text-xs">hue {{ user()?.avatarHue }}</span>
          </span>
        </app-settings-row>
        @if (user()?.createdAt) {
          <app-settings-row label="Member since">
            <span class="text-muted-foreground text-[13px]">{{ user()?.createdAt | fullDate }}</span>
          </app-settings-row>
        }
      </app-settings-group>
    </div>

    <app-settings-group title="Workspaces" description="Every workspace you can open with this account.">
      @for (w of session.workspaces(); track w.id) {
        <div class="flex min-h-12 items-center gap-3 px-4 py-2.5">
          <span class="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold">{{ w.name.charAt(0).toUpperCase() }}</span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13px] font-medium">{{ w.name }}</div>
            <div class="text-muted-foreground truncate font-mono text-xs">/{{ w.slug }}</div>
          </div>
          <span class="text-muted-foreground text-xs">{{ roleName(w) }}</span>
          @if (w.slug === store.slug()) {
            <span class="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[11px]">Current</span>
          } @else {
            <button hlmBtn size="sm" variant="outline" class="h-7" (click)="session.switchWorkspace(w.slug)">Open</button>
          }
        </div>
      }
      <div class="flex items-center px-4 py-2">
        <a hlmBtn variant="ghost" size="sm" class="text-muted-foreground -ml-2 h-7" routerLink="/new-workspace">
          <svg [lucideIcon]="plus" [size]="14"></svg> Create workspace
        </a>
      </div>
    </app-settings-group>

    <app-settings-group title="Session">
      <app-settings-row label="Sign out" description="End this session on this device.">
        <button hlmBtn variant="outline" size="sm" (click)="session.logout()">
          <svg [lucideIcon]="logout" [size]="14"></svg>
          Log out
        </button>
      </app-settings-row>
    </app-settings-group>
  `,
})
export class ProfileSection {
  protected readonly session = inject(SessionStore);
  protected readonly store = inject(NablaStore);
  private readonly clipboard = inject(Clipboard);
  protected readonly logout = LucideLogOut;
  protected readonly plus = LucidePlus;
  protected readonly user = computed(() => this.session.user() ?? this.store.me());
  protected readonly meRef = computed(() => {
    const u = this.user();
    return u ? ({ type: 'user', id: u.id } as const) : null;
  });
  protected readonly hueColor = computed(() => avatarColor(this.user()?.avatarHue ?? 0));
  protected readonly roleLabel = computed(() => {
    const r = this.session.role();
    return r ? ROLE_META[r].label : null;
  });

  protected roleName(w: Workspace): string {
    const role = (w as Workspace & { role?: Role }).role;
    return role ? ROLE_META[role].label : '';
  }

  protected copyEmail(): void {
    const email = this.user()?.email;
    if (email) void this.clipboard.copy(email, 'Email copied');
  }
}
