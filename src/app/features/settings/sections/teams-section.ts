import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronRight, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore } from '../../../core/stores/nabla.store';
import { UiStore } from '../../../core/stores/ui.store';
import { TEAM_EDIT_POLICIES, type Team } from '../../../core/contracts/domain';
import { AvatarStack } from '../../../shared/actor-avatar';
import { KeyChip } from '../../../shared/key-chip';
import { SECTION_KIT } from './section-kit';

/** Every team at a glance; editing happens on the team page. */
@Component({
  selector: 'app-teams-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, LucideDynamicIcon, AvatarStack, KeyChip, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header title="Teams" description="Teams own workstreams and triage issues. A team's key prefixes its workstreams, like AUTH-12. Each team has leads and an edit policy, set on the team page.">
        @if (canAdmin()) {
          <button actions hlmBtn size="sm" (click)="ui.openCreate('team')">
            <svg [lucideIcon]="plus" [size]="14"></svg> New team
          </button>
        }
      </app-section-header>

      <app-settings-group [title]="'Teams · ' + rows().length">
        @for (r of rows(); track r.team.id) {
          <a class="hover:bg-accent group flex min-h-13 items-center gap-3 px-4 py-2.5 transition-colors" [routerLink]="['/', slug(), 'teams', r.team.key]">
            <span class="size-3 shrink-0 rounded-[4px]" [style.background]="r.team.color"></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-[13px] font-medium">{{ r.team.name }}</span>
                <app-key-chip [value]="r.team.key" />
              </div>
              <div class="text-muted-foreground truncate text-xs">{{ r.team.description || 'No description' }}</div>
              <div class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px]">
                <span>{{ r.leads ? (r.leads === 1 ? '1 lead' : r.leads + ' leads') : 'No lead' }}</span>
                <span>·</span>
                <span [title]="r.policyHint">{{ r.policy }}</span>
              </div>
            </div>
            <span class="text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:inline">{{ r.workstreams }} ws · {{ r.issues }} issues</span>
            @if (r.members.length) {
              <app-avatar-stack [actors]="r.members" [max]="4" [size]="20" class="shrink-0" />
            } @else {
              <span class="text-muted-foreground shrink-0 text-xs">No members</span>
            }
            <span class="text-muted-foreground group-hover:text-foreground flex shrink-0 items-center gap-0.5 text-xs">
              {{ canEditTeam(r.team) ? 'Edit' : 'Open' }} <svg [lucideIcon]="chevron" [size]="13"></svg>
            </span>
          </a>
        } @empty {
          <div class="text-muted-foreground px-4 py-8 text-center text-[13px]">No teams yet.</div>
        }
      </app-settings-group>
    </div>
  `,
})
export class TeamsSection {
  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly plus = LucidePlus;
  protected readonly chevron = LucideChevronRight;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canAdmin = computed(() => this.store.allowed('createTeams'));
  protected canEditTeam(t: Team): boolean {
    return this.store.allowed('manageTeams') || this.store.isTeamLead(t.id);
  }
  protected readonly rows = computed(() =>
    [...this.store.teams()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((team: Team) => ({
        team,
        members: team.memberIds.map((id) => ({ type: 'user' as const, id })),
        workstreams: this.store.workstreamsByOwnerTeam().get(team.id)?.length ?? 0,
        issues: this.store.issuesByTeam().get(team.id)?.length ?? 0,
        leads: team.leadIds.length,
        policy: team.editPolicy === 'members' ? 'Members edit' : 'Everyone edits',
        policyHint: TEAM_EDIT_POLICIES[team.editPolicy].description,
      })),
  );
}
