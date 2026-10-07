import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { LucideDynamicIcon, LucideLogOut } from '@lucide/angular';
import { SessionStore } from '../../../core/session/session.store';
import { NablaStore } from '../../../core/stores/nabla.store';
import { ROLE_META } from '../../../core/meta';
import { avatarColor } from '../../../core/utils';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { FullDatePipe } from '../../../shared/pipes';
import { SECTION_KIT } from './section-kit';

@Component({
  selector: 'app-profile-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmInputImports, HlmButtonImports, ActorAvatar, LucideDynamicIcon, FullDatePipe, ...SECTION_KIT],
  template: `
    <app-section-header title="Profile" description="How you appear to your teammates and to agents." />

    <div class="bg-background mb-5 flex items-center gap-4 rounded-lg border p-4">
      <app-actor-avatar [actor]="meRef()" [size]="52" />
      <div class="min-w-0">
        <div class="truncate text-base font-semibold">{{ user()?.name }}</div>
        <div class="text-muted-foreground truncate text-sm">{{ user()?.email }}</div>
        @if (roleLabel(); as r) {
          <div class="text-muted-foreground mt-1 text-xs">{{ r }} in {{ store.workspace()?.name }}</div>
        }
      </div>
    </div>

    <app-settings-group>
      <app-settings-row label="Name" description="Shown on comments, decisions and assignments.">
        <input hlmInput readonly [value]="user()?.name ?? ''" aria-label="Name" />
      </app-settings-row>
      <app-settings-row label="Email" description="Used to sign in and to add you to workspaces.">
        <input hlmInput readonly [value]="user()?.email ?? ''" aria-label="Email" />
      </app-settings-row>
      <app-settings-row label="Avatar colour" description="Derived from your account, so it stays the same everywhere.">
        <div class="flex items-center gap-2">
          <span class="size-6 rounded-full" [style.background]="hueColor()"></span>
          <span class="text-muted-foreground font-mono text-xs">hue {{ user()?.avatarHue }}</span>
        </div>
      </app-settings-row>
      <app-settings-row label="Member since">
        <span class="text-sm">{{ user()?.createdAt | fullDate }}</span>
      </app-settings-row>
    </app-settings-group>
    <p class="text-muted-foreground mt-2 text-xs">Profile editing is not available yet.</p>

    <div class="mt-8">
      <app-settings-group>
        <app-settings-row label="Sign out" description="End this session on this device.">
          <button hlmBtn variant="outline" (click)="session.logout()">
            <svg [lucideIcon]="logout" [size]="14"></svg>
            Log out
          </button>
        </app-settings-row>
      </app-settings-group>
    </div>
  `,
})
export class ProfileSection {
  protected readonly session = inject(SessionStore);
  protected readonly store = inject(NablaStore);
  protected readonly logout = LucideLogOut;
  protected readonly user = this.session.user;
  protected readonly meRef = computed(() => {
    const u = this.user();
    return u ? ({ type: 'user', id: u.id } as const) : null;
  });
  protected readonly hueColor = computed(() => avatarColor(this.user()?.avatarHue ?? 0));
  protected readonly roleLabel = computed(() => {
    const r = this.session.role();
    return r ? ROLE_META[r].label : null;
  });
}
