import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import type {
  LunaGestConnectionConfigured,
  SaveLunaGestConnectionInput,
} from '../../../core/api/api.types';
import { TramaStore } from '../../../core/stores/trama.store';
import { SECTION_KIT } from './section-kit';

/**
 * Settings → LunaGest: one workspace connection (base URL, username, password).
 * Projects opt in separately. The password is write-only and cleared after a successful save.
 */
@Component({
  selector: 'app-lunagest-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, ...SECTION_KIT],
  template: `
    <app-section-header
      title="LunaGest"
      description="This connection is used only by projects that turn it on."
    />
    @if (!canManage()) {
      <app-readonly-note
        >Only admins can connect LunaGest. You can still see whether it is
        connected.</app-readonly-note
      >
    }

    @if (loading()) {
      <p class="text-muted-foreground text-[13px]">Loading…</p>
    } @else {
      @if (error(); as message) {
        <p class="text-destructive mb-4 text-[13px]" role="alert">{{ message }}</p>
      }

      @if (configured(); as connection) {
        <app-settings-group title="Connected" class="mb-8">
          <app-settings-row label="Account">
            <span class="text-[13px]">{{ connection.account }}</span>
          </app-settings-row>
          <app-settings-row label="Base URL">
            <span class="font-mono text-xs break-all">{{ connection.baseUrl }}</span>
          </app-settings-row>
        </app-settings-group>
      } @else if (!canManage() && !error()) {
        <p class="text-muted-foreground text-[13px]">Not connected.</p>
      }

      @if (canManage()) {
        <form (submit)="save($event)">
          <app-settings-group
            title="Credentials"
            description="Stored on the server. The password is not shown again."
          >
            <app-settings-row label="Base URL" description="Leave empty to use the default." wide>
              <input
                hlmInput
                class="h-8 w-full font-mono text-xs"
                type="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://panel.lunagest.com"
                aria-label="Base URL"
                [value]="baseUrl()"
                (input)="baseUrl.set($any($event.target).value)"
              />
            </app-settings-row>
            <app-settings-row label="Username" wide>
              <input
                hlmInput
                class="h-8 w-full text-[13px]"
                autocomplete="off"
                aria-label="Username"
                [value]="username()"
                (input)="username.set($any($event.target).value)"
              />
            </app-settings-row>
            <app-settings-row label="Password" wide>
              <input
                hlmInput
                class="h-8 w-full text-[13px]"
                type="password"
                autocomplete="off"
                aria-label="Password"
                [value]="password()"
                (input)="password.set($any($event.target).value)"
              />
            </app-settings-row>
            <div class="flex items-center justify-end gap-2 px-4 py-3">
              @if (configured()) {
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  [disabled]="busy()"
                  (click)="remove()"
                >
                  Remove
                </button>
              }
              <button hlmBtn type="submit" size="sm" [disabled]="!canSave()">Save</button>
            </div>
          </app-settings-group>
        </form>
      }
    }
  `,
})
export class LunagestSection {
  private readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);

  protected readonly canManage = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly connection = signal<LunaGestConnectionConfigured | null>(null);
  protected readonly configured = computed(() => this.connection());
  protected readonly baseUrl = signal('');
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly canSave = computed(
    () => !this.busy() && this.username().trim().length > 0 && this.password().trim().length > 0,
  );

  constructor() {
    effect(() => {
      const slug = this.store.slug();
      if (!slug || !this.store.ready()) return;
      untracked(() => void this.load(slug));
    });
  }

  private async load(slug: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const connection = await this.api.lunagest.connection(slug, { quiet: true });
      if (connection.configured) {
        this.connection.set(connection);
        this.baseUrl.set(connection.baseUrl);
      } else {
        this.connection.set(null);
      }
    } catch (e) {
      this.connection.set(null);
      this.error.set(ApiError.from(e).message);
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const slug = this.store.slug();
    if (!slug || !this.canSave()) return;
    const input: SaveLunaGestConnectionInput = {
      username: this.username().trim(),
      password: this.password(),
    };
    const baseUrl = this.baseUrl().trim();
    if (baseUrl) input.baseUrl = baseUrl;
    this.busy.set(true);
    this.error.set('');
    try {
      const saved = await this.api.lunagest.saveConnection(slug, input, { quiet: true });
      this.connection.set(saved);
      this.baseUrl.set(saved.baseUrl);
      this.password.set('');
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const slug = this.store.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.lunagest.removeConnection(slug, { quiet: true });
      this.connection.set(null);
      this.username.set('');
      this.password.set('');
      this.baseUrl.set('');
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
