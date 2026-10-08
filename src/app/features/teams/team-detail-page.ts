import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideEllipsis, LucideTrash2, LucideUsers } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, UiStore } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { ProviderIcon } from '../../shared/provider-icon';
import { PropertyRow } from '../../shared/property-row';
import { InlineText } from '../workstreams/inline-edit';
import { Picker } from '../workstreams/picker';
import { buildSummary, userOptions } from '../workstreams/ws-model';
import { WorkstreamRow } from '../workstreams/workstream-items';

@Component({
  selector: 'app-team-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    ActorAvatar,
    EmptyState,
    KeyChip,
    ProviderIcon,
    PropertyRow,
    InlineText,
    Picker,
    WorkstreamRow,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (team(); as t) {
      <ng-template appTopBarActions>
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="newWorkstream()">New workstream</button>
        }
        @if (canAdmin()) {
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Team actions">
            <svg [lucideIcon]="moreIcon" [size]="16"></svg>
          </button>
          <ng-template #more>
            <hlm-dropdown-menu class="w-40">
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete team
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        }
      </ng-template>

      <header class="border-b px-4 pt-3 sm:px-6">
        <div class="flex min-w-0 items-center gap-2">
          <span class="size-2.5 shrink-0 rounded-full" [style.background]="t.color"></span>
          <app-inline-text class="min-w-0 flex-1" label="name" textClass="text-lg font-semibold tracking-tight" [value]="t.name" [canEdit]="canAdmin()" (save)="saveName($event)" />
          <app-key-chip [value]="t.key" />
        </div>
        <p class="text-muted-foreground pb-3 text-xs">Key {{ t.key }} prefixes this team's workstreams and cannot change.</p>
      </header>

      <div class="grid gap-x-8 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="flex min-w-0 flex-col gap-8">
          <section>
            <h2 class="mb-1 text-sm font-semibold">Owns</h2>
            @if (owned().length) {
              <div class="-mx-4 sm:-mx-6">
                @for (s of owned(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              </div>
            } @else {
              <p class="text-muted-foreground text-sm">This team does not own a workstream yet.</p>
            }
          </section>
          @if (participating().length) {
            <section>
              <h2 class="mb-1 text-sm font-semibold">Participates in</h2>
              <div class="-mx-4 sm:-mx-6">
                @for (s of participating(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              </div>
            </section>
          }
          <section>
            <h2 class="mb-2 text-sm font-semibold">Projects</h2>
            @if (projects().length) {
              @for (p of projects(); track p.id) {
                <a class="hover:bg-muted/60 flex items-center gap-2 border-b py-1.5 text-sm" [routerLink]="['/', slug(), 'projects', p.id]">
                  <app-provider-icon [provider]="p.provider" [size]="14" />
                  <span class="truncate font-mono text-xs">{{ p.fullName }}</span>
                </a>
              }
            } @else {
              <p class="text-muted-foreground text-sm">No project is linked to this team.</p>
            }
          </section>
        </div>

        <aside class="flex flex-col">
          <app-property-row label="Description">
            <app-inline-text class="min-w-0 flex-1" label="description" placeholder="What does this team own?" textClass="text-xs" [value]="t.description ?? ''" [allowEmpty]="true" [canEdit]="canAdmin()" (save)="saveDescription($event)" />
          </app-property-row>
          <app-property-row label="Members">
            <app-picker variant="field" label="Members" placeholder="No members" [multiple]="true" [disabled]="!canAdmin()" [options]="users()" [value]="t.memberIds" (valueChange)="saveMembers($event)" />
          </app-property-row>
          <ul class="mt-2 flex flex-col gap-1.5">
            @for (id of t.memberIds; track id) {
              @if (user(id); as u) {
                <li class="flex items-center gap-2 text-sm">
                  <app-actor-avatar [actor]="{ type: 'user', id: u.id }" [size]="20" />
                  <span class="min-w-0 flex-1 truncate">{{ u.name }}</span>
                  <span class="text-muted-foreground truncate text-xs">{{ u.email }}</span>
                </li>
              }
            } @empty {
              <li class="text-muted-foreground text-sm">No members yet.</li>
            }
          </ul>
        </aside>
      </div>
    } @else {
      <app-empty-state [icon]="usersIcon" title="Team not found" description="It may have been deleted.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'teams']">Back to teams</a>
      </app-empty-state>
    }
  `,
})
export class TeamDetailPage {
  readonly workspaceSlug = input<string>();
  readonly key = input<string>();

  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);

  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly usersIcon = LucideUsers;
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly team = computed(() => this.store.getTeam(this.key()));
  protected readonly owned = computed(() => {
    const id = this.team()?.id;
    return id ? (this.store.workstreamsByOwnerTeam().get(id) ?? []).map((ws) => buildSummary(this.store, ws)) : [];
  });
  protected readonly participating = computed(() => {
    const id = this.team()?.id;
    return id ? (this.store.workstreamsByParticipatingTeam().get(id) ?? []).map((ws) => buildSummary(this.store, ws)) : [];
  });
  protected readonly projects = computed(() => {
    const id = this.team()?.id;
    if (!id) return [];
    return this.store.repositories().filter((r) => r.teamIds.includes(id));
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Teams', link: ['/', this.slug(), 'teams'] },
    { label: this.team()?.key ?? this.key() ?? '', mono: true },
  ]);

  protected user(id: string) {
    return this.store.userById().get(id);
  }
  protected saveName(name: string): void {
    const t = this.team();
    if (t && name.trim()) void this.store.updateTeam(t.id, { name: name.trim() });
  }
  protected saveDescription(description: string): void {
    const t = this.team();
    if (t) void this.store.updateTeam(t.id, { description: description.trim() || null });
  }
  protected saveMembers(memberIds: string[]): void {
    const t = this.team();
    if (!t) return;
    void this.store.updateTeam(t.id, { memberIds });
  }
  protected newWorkstream(): void {
    const t = this.team();
    if (t) this.ui.openCreate('workstream', { ownerTeamId: t.id });
  }
  protected remove(): void {
    const t = this.team();
    if (!t) return;
    this.ui.setConfirmDelete({
      title: `Delete ${t.name}?`,
      description: 'Workstreams keep their history. New ones will need another owner team.',
      onConfirm: async () => {
        const ok = await this.store.deleteTeam(t.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'teams']);
      },
    });
  }
}
