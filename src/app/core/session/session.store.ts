// SessionStore — who is signed in, which workspaces they belong to, which one is active.
// Exact public API relied on by UI/feature code (see ../CONTRACT.md).
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type { UpdateWorkspaceInput } from '../api/api.types';
import type { Role, User, Workspace } from '../contracts/domain';
import { ROLE_META } from '../meta';
import { Notifier } from '../notify/notifier';
import { Preferences } from '../preferences';
import { readJson, writeJson } from '../stores/storage';
import { ListStateStore } from '../stores/list-state.store';
import { NablaStore } from '../stores/nabla.store';

const LAST_WORKSPACE_KEY = 'nabla.session.v1';

export type EnterResult = 'ok' | 'not-found' | 'error';

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(ApiClient);
  private readonly nabla = inject(NablaStore);
  private readonly listState = inject(ListStateStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);
  private readonly preferences = inject(Preferences);

  private readonly _user = signal<User | null>(null);
  private readonly _workspaces = signal<Workspace[]>([]);
  private readonly _workspace = signal<Workspace | null>(null);
  private readonly _role = signal<Role | null>(null);
  private readonly _ready = signal(false);

  /** The signed-in user, or null. */
  readonly user = this._user.asReadonly();
  /** Workspaces the user belongs to. */
  readonly workspaces = this._workspaces.asReadonly();
  /** The active workspace (set once its snapshot loaded), or null. */
  readonly workspace = this._workspace.asReadonly();
  /** The user's role in the active workspace, or null. */
  readonly role = this._role.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);
  /** True once `init()` has resolved (the initial /auth/me check is done). */
  readonly ready = this._ready.asReadonly();

  private initPromise: Promise<void> | null = null;

  constructor() {
    this.api.sessionExpired.subscribe(() => this.handleExpired());
  }

  /** Check the cookie session (GET /auth/me) and load the user's workspaces. Idempotent. */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const me = await this.api.auth.me();
      this._user.set(me.user);
      this._workspaces.set(me.workspaces ?? (await this.api.workspaces.list()));
    } catch (e) {
      const err = ApiError.from(e);
      this._user.set(null);
      this._workspaces.set([]);
      // 401 = signed out (normal). Anything else (server down) also leaves us signed out.
      if (err.status !== 401) console.warn('[nabla] session check failed:', err.message);
    } finally {
      this._ready.set(true);
    }
  }

  /** Re-run the session check (e.g. after login). */
  private async refresh(): Promise<void> {
    this.initPromise = null;
    this._ready.set(false);
    await this.init();
  }

  /** Sign in. Rejects with `ApiError` (show `message` in the form). */
  async login(email: string, password: string): Promise<void> {
    const user = await this.api.auth.login({ email, password });
    this._user.set(user);
    await this.loadWorkspaces();
    this.initPromise = Promise.resolve();
    this._ready.set(true);
  }

  /** Create an account and sign in. Rejects with `ApiError`. */
  async signup(name: string, email: string, password: string): Promise<void> {
    const user = await this.api.auth.signup({ name, email, password });
    this._user.set(user);
    await this.loadWorkspaces();
    this.initPromise = Promise.resolve();
    this._ready.set(true);
  }

  /** Sign out, forget all workspace data, go to /login. */
  async logout(): Promise<void> {
    try {
      await this.api.auth.logout();
    } catch {
      /* cookie may already be gone */
    }
    this.clear();
    await this.router.navigate(['/login']);
  }

  /** Navigate to another workspace (its overview). */
  async switchWorkspace(slug: string): Promise<void> {
    if (slug === this._workspace()?.slug) return;
    await this.router.navigate(['/', slug, 'overview']);
  }

  /** Create a workspace, add it to `workspaces()` and open it. Rejects with `ApiError`. */
  async createWorkspace(name: string, slug: string): Promise<Workspace> {
    const ws = await this.api.workspaces.create({ name, slug });
    this._workspaces.update((list) => [...list.filter((w) => w.id !== ws.id), ws]);
    await this.router.navigate(['/', ws.slug, 'overview']);
    return ws;
  }

  /** Rename / re-slug the active workspace (admin). Navigates when the slug changes. */
  async updateWorkspace(patch: UpdateWorkspaceInput): Promise<boolean> {
    const current = this._workspace();
    if (!current) return false;
    try {
      const ws = await this.api.workspaces.update(current.slug, patch);
      this._workspaces.update((list) => list.map((w) => (w.id === ws.id ? ws : w)));
      this._workspace.set(ws);
      if (ws.slug !== current.slug) {
        this.remember(ws.slug);
        await this.router.navigate(['/', ws.slug, 'settings', 'workspace']);
      } else {
        this.nabla.scheduleRefetch(0);
      }
      return true;
    } catch (e) {
      this.reportFailure('update workspace', e);
      return false;
    }
  }

  /**
   * Delete the active workspace (owner), then go to another one (or /new-workspace). `confirm` is the slug or
   * name the user typed; the server refuses anything else.
   */
  async deleteWorkspace(confirm: string): Promise<boolean> {
    const current = this._workspace();
    if (!current) return false;
    try {
      await this.api.workspaces.remove(current.slug, confirm);
    } catch (e) {
      this.reportFailure('delete workspace', e);
      return false;
    }
    this._workspaces.update((list) => list.filter((w) => w.id !== current.id));
    this.nabla.reset();
    this._workspace.set(null);
    this._role.set(null);
    this.forgetIf(current.slug);
    await this.router.navigateByUrl('/');
    return true;
  }

  /** True when the user's role in the active workspace is at least `minRole`. */
  can(minRole: Role): boolean {
    const mine = this._role();
    return mine !== null && ROLE_META[mine].rank >= ROLE_META[minRole].rank;
  }

  /** After login / signup: go to `next` (a same-origin path) or the default workspace. */
  async goAfterAuth(next?: string | null): Promise<void> {
    const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
    await this.router.navigateByUrl(safe ?? this.defaultWorkspaceUrl());
  }

  /** `/<last used or first workspace>/<home view>`, or `/new-workspace` when there is none. */
  defaultWorkspaceUrl(): string {
    const list = this._workspaces();
    const last = readJson<{ lastSlug: string }>(LAST_WORKSPACE_KEY)?.lastSlug;
    const target = list.find((w) => w.slug === last) ?? list[0];
    return target ? `/${target.slug}/${this.preferences.homeView()}` : '/new-workspace';
  }

  /**
   * Make `slug` the active workspace: loads its snapshot into NablaStore. Used by
   * `workspaceGuard`. `not-found` = unknown workspace or not a member.
   */
  async enterWorkspace(slug: string): Promise<EnterResult> {
    await this.init();
    const result = await this.nabla.load(slug);
    if (result !== 'ok') return result;
    const ws = this.nabla.workspace();
    if (ws) {
      this._workspace.set(ws);
      this._role.set(this.nabla.myRole());
      this._workspaces.update((list) => (list.some((w) => w.id === ws.id) ? list : [...list, ws]));
      this.remember(ws.slug);
    }
    return 'ok';
  }

  // ───────────── internals ─────────────

  private async loadWorkspaces(): Promise<void> {
    try {
      this._workspaces.set(await this.api.workspaces.list());
    } catch {
      this._workspaces.set([]);
    }
  }

  private clear(): void {
    this._user.set(null);
    this._workspaces.set([]);
    this._workspace.set(null);
    this._role.set(null);
    this.nabla.reset();
    this.listState.clear();
    this.initPromise = Promise.resolve();
    this._ready.set(true);
  }

  private handleExpired(): void {
    if (!this._user()) return;
    this.clear();
    const url = this.router.url;
    const onAuthPage = /^\/(login|register)(\?|$)/.test(url);
    if (onAuthPage) return;
    this.notifier.info('Your session expired', { description: 'Sign in again to continue.' });
    void this.router.navigate(['/login'], { queryParams: url && url !== '/' ? { next: url } : {} });
  }

  private remember(slug: string): void {
    writeJson(LAST_WORKSPACE_KEY, { lastSlug: slug });
  }

  private forgetIf(slug: string): void {
    if (readJson<{ lastSlug: string }>(LAST_WORKSPACE_KEY)?.lastSlug === slug) writeJson(LAST_WORKSPACE_KEY, {});
  }

  private reportFailure(action: string, e: unknown): void {
    const err = ApiError.from(e);
    if (err.status !== 401 && err.status !== 403) {
      this.notifier.error(`Could not ${action}`, { description: err.message });
    }
  }
}
