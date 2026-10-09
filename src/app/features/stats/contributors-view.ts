import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AgentFailureRow, InsightContributor, InsightsReport } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { BarList, type BarRow } from './charts/bar-list';
import { ChartCard } from './charts/chart-card';
import type { ChartSlice } from './charts/chart-utils';
import { StackBar } from './charts/stack-bar';
import { actorRef } from './insights-model';

/**
 * People and agents side by side: who changes things, and where agents struggle. Agents are actors,
 * not assignees, so everything here is activity the log recorded, never an assignment.
 */
@Component({
  selector: 'app-contributors-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ActorAvatar, BarList, ChartCard, StackBar],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <app-chart-card
      title="Who does the work"
      [subtitle]="'Recorded changes in the last ' + report().range.days + ' days, people against agents'"
      [empty]="slices().length ? undefined : 'Nobody changed anything in this range.'"
      note="Counts every change in the activity log by the person or agent who made it. System re-derivations are left out."
    >
      <app-stack-bar [slices]="slices()" [legend]="true" [thickness]="12" />
    </app-chart-card>

    <div class="grid gap-4 lg:grid-cols-2">
      <app-chart-card title="People" subtitle="Changes made" [empty]="people().length ? undefined : 'No person made a change in this range.'">
        <app-bar-list [rows]="people()" ariaLabel="Changes per person" />
      </app-chart-card>
      <app-chart-card title="Agents" subtitle="Changes made" [empty]="agents().length ? undefined : 'No agent made a change in this range.'">
        <app-bar-list [rows]="agents()" defaultColor="var(--chart-4)" ariaLabel="Changes per agent" />
      </app-chart-card>
    </div>

    <app-chart-card
      title="Agent failure signals"
      subtitle="Where agents get stuck or produce work that does not stick"
      [empty]="failures().length ? undefined : 'No agent has raised questions or opened pull requests in this range.'"
    >
      <div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table class="w-full min-w-[40rem] text-xs">
          <caption class="sr-only">Failure signals per agent</caption>
          <thead>
            <tr class="text-muted-foreground border-b text-start">
              <th scope="col" class="py-2 pe-3 text-start font-normal">Agent</th>
              <th scope="col" class="px-3 py-2 text-end font-normal">Questions raised</th>
              <th scope="col" class="px-3 py-2 text-end font-normal">Still open</th>
              <th scope="col" class="px-3 py-2 text-end font-normal">Median answer</th>
              <th scope="col" class="px-3 py-2 text-end font-normal">PRs</th>
              <th scope="col" class="px-3 py-2 text-end font-normal">Abandoned</th>
              <th scope="col" class="px-3 py-2 text-end font-normal">CI failing</th>
              <th scope="col" class="py-2 ps-3 text-end font-normal">Reopened</th>
            </tr>
          </thead>
          <tbody>
            @for (f of failures(); track f.agent.id) {
              <tr class="border-b last:border-0">
                <th scope="row" class="py-2 pe-3 text-start font-normal">
                  <span class="flex items-center gap-2">
                    @if (ref(f); as r) {
                      <app-actor-avatar [actor]="r" [size]="18" />
                    }
                    <span class="font-medium">{{ f.agent.name }}</span>
                  </span>
                </th>
                <td class="px-3 py-2 text-end tabular-nums">{{ f.inputRequestsRaised }}</td>
                <td class="px-3 py-2 text-end tabular-nums" [class.text-tone-amber]="f.inputRequestsOpen > 0" [class.font-medium]="f.inputRequestsOpen > 0">{{ f.inputRequestsOpen }}</td>
                <td class="px-3 py-2 text-end tabular-nums">{{ f.medianAnswerHours === undefined ? '—' : hours(f.medianAnswerHours) }}</td>
                <td class="px-3 py-2 text-end tabular-nums">{{ f.pullRequests }}</td>
                <td class="px-3 py-2 text-end tabular-nums" [class.text-tone-red]="f.pullRequestsAbandoned > 0" [class.font-medium]="f.pullRequestsAbandoned > 0">{{ f.pullRequestsAbandoned }}</td>
                <td class="px-3 py-2 text-end tabular-nums" [class.text-tone-red]="f.pullRequestsCiFailing > 0" [class.font-medium]="f.pullRequestsCiFailing > 0">{{ f.pullRequestsCiFailing }}</td>
                <td class="py-2 ps-3 text-end tabular-nums" [class.text-tone-red]="f.issuesReopened > 0" [class.font-medium]="f.issuesReopened > 0">{{ f.issuesReopened }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <ul class="text-meta mt-3 flex flex-col gap-1 text-[11px]">
        <li><strong class="text-muted-foreground font-medium">Questions raised / still open:</strong> input requests the agent asked; open ones wait for a person. See them under <a class="underline underline-offset-2" [routerLink]="healthLink()" [queryParams]="{ scope: 'health', signal: 'needs_input' }">Waiting for input</a>.</li>
        <li><strong class="text-muted-foreground font-medium">Abandoned:</strong> pull requests it opened in the range that were closed without merging.</li>
        <li><strong class="text-muted-foreground font-medium">CI failing:</strong> its open pull requests whose latest CI is failing.</li>
        <li><strong class="text-muted-foreground font-medium">Reopened:</strong> issues it moved to Done that someone later moved out of Done.</li>
      </ul>
    </app-chart-card>
  `,
})
export class ContributorsView {
  readonly report = input.required<InsightsReport>();
  readonly slug = input.required<string>();

  protected readonly healthLink = computed(() => ['/', this.slug(), 'stats']);
  protected readonly slices = computed<ChartSlice[]>(() => {
    const a = this.report().actors;
    const people = a.people.reduce((n, c) => n + c.events, 0);
    const agents = a.agents.reduce((n, c) => n + c.events, 0);
    return [
      { key: 'people', label: 'People', value: people, color: 'var(--chart-1)' },
      { key: 'agents', label: 'Agents', value: agents, color: 'var(--chart-4)' },
    ].filter((s) => s.value > 0);
  });
  protected readonly people = computed(() => this.rows(this.report().actors.people));
  protected readonly agents = computed(() => this.rows(this.report().actors.agents));
  protected readonly failures = computed(() => this.report().actors.failures);

  protected ref(f: AgentFailureRow) {
    return actorRef(f.agent);
  }

  protected hours(h: number): string {
    return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  }

  private rows(list: readonly InsightContributor[]): BarRow[] {
    return list.slice(0, 10).map((c) => ({
      key: c.actor.id,
      label: c.actor.name,
      value: c.events,
      detail: `${c.actor.name}: ${c.events} changes, ${c.issuesDone} issues done, ${c.comments} comments, ${c.pullRequests} pull requests`,
      hint: c.issuesDone ? `${c.issuesDone} done` : undefined,
    }));
  }
}
