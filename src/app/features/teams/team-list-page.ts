import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus, LucideSearch, LucideUsers } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, UiStore } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { AvatarStack } from '../../shared/actor-avatar';
import { StatusIcon } from '../../shared/status';

const OPEN_ISSUE = new Set(['backlog', 'todo', 'in_progress', 'in_review']);

@Component({
  selector: 'app-team-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, Kbd, EmptyState, KeyChip, TopBarActions, AvatarStack, StatusIcon],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canAdmin()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New team</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Teams" [description]="description()" />

    <div class="border-b px-4 py-2 sm:px-6">
      <div class="relative w-full sm:w-52">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input hlmInput class="h-10 w-full pl-9 text-sm" placeholder="Search teams…" aria-label="Search teams" [value]="search()" (input)="search.set($any($event.target).value)" />
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="users" title="No teams yet" description="Teams own workstreams (outcomes, keyed like AUTH-12) and triage issues (incoming demand). Each team has a short key that prefixes its workstreams.">
        @if (canAdmin()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New team</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No teams match" description="Try another name or key." />
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        <div class="text-muted-foreground bg-muted/30 hidden items-center gap-3 border-b px-4 py-1.5 text-xs sm:px-6 md:flex">
          <span class="flex-1">Name</span>
          <span class="w-24">Members</span>
          <span class="w-28 text-right">Workstreams</span>
          <span class="w-20 text-right">Issues</span>
        </div>
        @for (r of shown(); track r.team.id) {
          <a
            [routerLink]="['/', slug(), 'teams', r.team.key]"
            [attr.data-row-id]="r.team.id"
            role="listitem"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 flex min-h-16 items-center gap-3 border-b px-4 py-3 outline-none sm:px-6 md:min-h-11 md:py-2"
            [class.bg-muted]="ui.focusedRowId() === r.team.id"
          >
            <span class="flex size-6 shrink-0 items-center justify-center rounded-md" [style.background]="r.tint">
              <span class="size-2.5 rounded-full" [style.background]="r.team.color"></span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium">{{ r.team.name }}</span>
                <app-key-chip [value]="r.team.key" />
              </span>
              @if (r.team.description) {
                <span class="text-muted-foreground block truncate text-xs">{{ r.team.description }}</span>
              }
            </span>
            <span class="hidden w-24 items-center md:flex">
              @if (r.members.length) {
                <app-avatar-stack [actors]="r.members" [max]="4" [size]="20" />
              } @else {
                <span class="text-muted-foreground text-xs">—</span>
              }
            </span>
            <span class="text-muted-foreground flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs tabular-nums max-md:hidden">
              <app-status-icon status="working" entity="workstream" [size]="12" />{{ r.active }}<span class="opacity-60">/ {{ r.owned }}</span>
            </span>
            <span class="text-muted-foreground flex w-20 shrink-0 items-center justify-end gap-1.5 text-[13px] tabular-nums">
              <app-status-icon status="todo" entity="issue" [size]="12" />{{ r.openIssues }}
            </span>
          </a>
        }
      </div>
    }
  `,
})
export class TeamListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly users = LucideUsers;
  protected readonly search = signal('');
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.allowed('createTeams'));
  protected readonly total = computed(() => this.store.teams().length);
  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const owned = this.store.workstreamsByOwnerTeam();
    const issues = this.store.issuesByTeam();
    return this.store
      .teams()
      .filter((t) => !q || `${t.name} ${t.key} ${t.description ?? ''}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((team) => {
        const ws = owned.get(team.id) ?? [];
        return {
          team,
          tint: `color-mix(in oklab, ${team.color} 16%, transparent)`,
          members: team.memberIds.map((id) => ({ type: 'user' as const, id })),
          owned: ws.length,
          active: ws.filter((w) => w.status !== 'shipped' && w.status !== 'canceled' && w.status !== 'draft').length,
          openIssues: (issues.get(team.id) ?? []).filter((i) => OPEN_ISSUE.has(i.status)).length,
        };
      });
  });
  protected readonly description = computed(() => {
    const n = this.total();
    return n === 1 ? '1 team' : `${n} teams`;
  });

  protected create(): void {
    this.ui.openCreate('team');
  }
}
