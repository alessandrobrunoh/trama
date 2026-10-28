import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type {
  LunaGestConnection,
  LunaGestProjectLink,
  LunaGestRealignResult,
  LunaGestRemoteProject,
} from '../../core/api/api.types';
import { TramaStore } from '../../core/stores/trama.store';

const SELECT =
  'border-border bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-[13px] sm:max-w-xs';

/**
 * Project overview: link this project to a LunaGest project when the workspace connection exists.
 * Realign pulls or pushes linked task fields. A field both sides changed is left for a choice.
 */
@Component({
  selector: 'app-project-lunagest',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports],
  host: { class: 'block' },
  template: `
    <section class="flex flex-col gap-2" aria-label="LunaGest">
      <h2 class="text-[13px] font-semibold">LunaGest</h2>

      @if (loading()) {
        <p class="text-muted-foreground text-[13px]">Loading…</p>
      } @else if (!connection()) {
        @if (error(); as message) {
          <p class="text-destructive text-[13px]" role="alert">{{ message }}</p>
        }
      } @else if (connection(); as current) {
        @if (current.configured === false) {
          <p class="text-muted-foreground text-[13px]">
            LunaGest is not connected for this workspace.
            <a
              class="text-primary hover:underline"
              [routerLink]="['/', slug(), 'settings', 'lunagest']"
              >Connect it in settings</a
            >
          </p>
        } @else if (!canManage()) {
          <p class="text-[13px]">
            @if (linkedName(); as name) {
              Linked to {{ name }}
            } @else {
              Not linked
            }
          </p>
        } @else {
          @if (linkedName(); as name) {
            <p class="text-muted-foreground text-[13px]">Linked to {{ name }}</p>
          }
          @if (remoteLoading()) {
            <p class="text-muted-foreground text-[13px]">Loading projects…</p>
          } @else {
            @if (remoteError(); as message) {
              <p class="text-destructive text-[13px]" role="alert">{{ message }}</p>
            }
            <div class="flex flex-wrap items-center gap-2">
              @if (!remoteError()) {
                <select
                  [class]="select"
                  aria-label="LunaGest project"
                  [value]="remoteProjectId()"
                  (change)="remoteProjectId.set($any($event.target).value)"
                >
                  <option value="" [selected]="remoteProjectId() === ''">Select a project</option>
                  @for (project of choices(); track project.id) {
                    <option [value]="project.id" [selected]="remoteProjectId() === project.id">
                      {{ project.name }}
                    </option>
                  }
                </select>
                <button
                  hlmBtn
                  type="button"
                  size="sm"
                  [disabled]="!remoteProjectId() || busy()"
                  (click)="save()"
                >
                  Save
                </button>
              }
              @if (link()?.state === 'linked') {
                <button
                  hlmBtn
                  type="button"
                  size="sm"
                  variant="outline"
                  [disabled]="busy()"
                  (click)="unlink()"
                >
                  Unlink
                </button>
                <button
                  hlmBtn
                  type="button"
                  size="sm"
                  variant="outline"
                  [disabled]="busy()"
                  (click)="realign()"
                >
                  Realign
                </button>
              }
            </div>
            @if (realignResult(); as report) {
              <p class="text-muted-foreground text-[13px]">
                Pulled {{ report.pulled.length }}, pushed {{ report.pushed.length }}.
                @if (report.skipped.length) {
                  {{ report.skipped.length }} left unlinked.
                }
              </p>
              @for (conflict of report.conflicts; track conflict.issueId + conflict.field) {
                <div class="flex flex-col gap-1 rounded-md border px-2 py-2 text-[13px]">
                  <p>
                    {{ conflict.issueKey }} {{ conflict.field }} differs.
                    <span class="text-muted-foreground">Trama: {{ conflict.local || 'empty' }}</span>
                    ·
                    <span class="text-muted-foreground">LunaGest: {{ conflict.remote || 'empty' }}</span>
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <button
                      hlmBtn
                      type="button"
                      size="sm"
                      variant="outline"
                      [disabled]="busy()"
                      (click)="choose(conflict, 'local')"
                    >
                      Keep Trama
                    </button>
                    <button
                      hlmBtn
                      type="button"
                      size="sm"
                      variant="outline"
                      [disabled]="busy()"
                      (click)="choose(conflict, 'remote')"
                    >
                      Use LunaGest
                    </button>
                  </div>
                </div>
              }
            }
          }
          @if (actionError(); as message) {
            <p class="text-destructive text-[13px]" role="alert">{{ message }}</p>
          }
        }
      }
    </section>
  `,
})
export class ProjectLunagest {
  private readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);

  readonly projectId = input.required<string>();
  readonly canManage = input(false);

  protected readonly select = SELECT;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly actionError = signal('');
  protected readonly remoteLoading = signal(false);
  protected readonly remoteError = signal('');
  protected readonly connection = signal<LunaGestConnection | null>(null);
  protected readonly link = signal<LunaGestProjectLink | null>(null);
  protected readonly remoteProjects = signal<LunaGestRemoteProject[]>([]);
  protected readonly remoteProjectId = signal('');
  protected readonly realignResult = signal<LunaGestRealignResult | null>(null);
  protected readonly linkedName = computed(() => {
    const link = this.link();
    return link?.state === 'linked' ? link.remoteProjectName : '';
  });
  protected readonly choices = computed(() => {
    const projects = this.remoteProjects();
    const link = this.link();
    if (
      link?.state !== 'linked' ||
      projects.some((project) => project.id === link.remoteProjectId)
    ) {
      return projects;
    }
    return [{ id: link.remoteProjectId, name: link.remoteProjectName }, ...projects];
  });

  private generation = 0;

  constructor() {
    effect(() => {
      const slug = this.store.slug();
      const projectId = this.projectId();
      if (!slug || !projectId || !this.store.ready()) return;
      untracked(() => void this.load(slug, projectId));
    });
    effect(() => {
      const slug = this.store.slug();
      const connection = this.connection();
      const manage = this.canManage();
      if (!slug || !connection?.configured || !manage) return;
      untracked(() => void this.loadRemote(slug));
    });
  }

  private async load(slug: string, projectId: string): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    this.actionError.set('');
    this.remoteLoading.set(false);
    this.remoteError.set('');
    this.remoteProjects.set([]);
    try {
      const [connection, link] = await Promise.all([
        this.api.lunagest.connection(slug, { quiet: true }),
        this.api.lunagest.project(slug, projectId, { quiet: true }),
      ]);
      if (generation !== this.generation) return;
      this.connection.set(connection);
      this.link.set(link);
      this.remoteProjectId.set(link.state === 'linked' ? link.remoteProjectId : '');
      if (connection.configured && this.canManage()) this.remoteLoading.set(true);
    } catch (e) {
      if (generation !== this.generation) return;
      this.connection.set(null);
      this.link.set(null);
      this.error.set(ApiError.from(e).message);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  private async loadRemote(slug: string): Promise<void> {
    const generation = this.generation;
    this.remoteLoading.set(true);
    this.remoteError.set('');
    try {
      const projects = await this.api.lunagest.remoteProjects(slug, { quiet: true });
      if (generation !== this.generation) return;
      this.remoteProjects.set(projects);
    } catch (e) {
      if (generation !== this.generation) return;
      this.remoteProjects.set([]);
      this.remoteError.set(ApiError.from(e).message);
    } finally {
      if (generation === this.generation) this.remoteLoading.set(false);
    }
  }

  protected async save(): Promise<void> {
    const slug = this.store.slug();
    const remoteProjectId = this.remoteProjectId();
    if (!slug || !remoteProjectId || this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      const linked = await this.api.lunagest.linkProject(
        slug,
        this.projectId(),
        { remoteProjectId },
        { quiet: true },
      );
      this.link.set(linked);
      this.remoteProjectId.set(linked.remoteProjectId);
    } catch (e) {
      this.actionError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async realign(): Promise<void> {
    const slug = this.store.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      this.realignResult.set(
        await this.api.lunagest.realign(slug, this.projectId(), [], { quiet: true }),
      );
    } catch (e) {
      this.actionError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async choose(
    conflict: LunaGestRealignResult['conflicts'][number],
    take: 'local' | 'remote',
  ): Promise<void> {
    const slug = this.store.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      this.realignResult.set(
        await this.api.lunagest.realign(
          slug,
          this.projectId(),
          [{ issueId: conflict.issueId, field: conflict.field, take }],
          { quiet: true },
        ),
      );
    } catch (e) {
      this.actionError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async unlink(): Promise<void> {
    const slug = this.store.slug();
    if (!slug || this.busy() || this.link()?.state !== 'linked') return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      await this.api.lunagest.unlinkProject(slug, this.projectId(), { quiet: true });
      this.link.set({ state: 'unlinked' });
    } catch (e) {
      this.actionError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
