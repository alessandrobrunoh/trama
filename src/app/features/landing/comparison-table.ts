import { ChangeDetectionStrategy, Component } from '@angular/core';

interface ComparisonRow {
  topic: string;
  trello: string;
  jira: string;
  linear: string;
  trama: string;
}

/** Trello, Jira, Linear and Trama side by side; used on the landing page and in the blog. */
export const COMPARISON: readonly ComparisonRow[] = [
  {
    topic: 'Unit of work',
    trello: 'A card on a board',
    jira: 'An issue in an epic → story → sub-task tree',
    linear: 'An issue, grouped into projects and cycles',
    trama: 'Issues for demand, workstreams for the outcome',
  },
  {
    topic: 'Many issues, one fix',
    trello: 'Labels or a dedicated list',
    jira: 'Epics and issue links',
    linear: 'Projects and issue relations',
    trama: 'One workstream groups the issues that share a root cause',
  },
  {
    topic: 'Why it was done this way',
    trello: 'Card comments',
    jira: 'Comments, or a page in Confluence',
    linear: 'Comments and project docs',
    trama: 'Decisions as first-class records: proposed, accepted, superseded',
  },
  {
    topic: 'What was delivered',
    trello: 'Power-Ups',
    jira: 'Development panel per issue',
    linear: 'Linked pull requests per issue',
    trama: 'Artifacts per workstream with CI and review state, traced back to issues',
  },
  {
    topic: 'Progress',
    trello: 'Where the card sits',
    jira: 'Story points and burndown',
    linear: 'Cycle and project progress',
    trama: 'Status derived from facts: issues resolved, PRs merged, criteria met',
  },
  {
    topic: 'Coding agents',
    trello: 'Third-party automations',
    jira: 'An assignee on a ticket',
    linear: 'An assignee on a ticket',
    trama: 'Contributors on a workstream, with scoped tokens and usage caps',
  },
  {
    topic: 'Open source & self-hosting',
    trello: 'No',
    jira: 'Data Center only (paid, closed source)',
    linear: 'No',
    trama: 'AGPL-3.0, runs on your own PostgreSQL',
  },
];

@Component({
  selector: 'app-comparison-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="border-border bg-card overflow-x-auto rounded-xl border">
      <table class="w-full min-w-[46rem] border-collapse text-left text-[13px]">
        <thead>
          <tr class="border-border border-b">
            <th scope="col" class="text-muted-foreground w-[17%] px-4 py-3 font-normal"></th>
            <th scope="col" class="w-[19%] px-4 py-3 font-medium">Trello</th>
            <th scope="col" class="w-[19%] px-4 py-3 font-medium">Jira</th>
            <th scope="col" class="w-[19%] px-4 py-3 font-medium">Linear</th>
            <th scope="col" class="bg-primary/6 text-primary w-[26%] px-4 py-3 font-semibold">
              Trama
            </th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows; track row.topic) {
            <tr class="border-border/70 border-b last:border-b-0">
              <th scope="row" class="px-4 py-3 align-top font-medium">{{ row.topic }}</th>
              <td class="text-muted-foreground px-4 py-3 align-top">{{ row.trello }}</td>
              <td class="text-muted-foreground px-4 py-3 align-top">{{ row.jira }}</td>
              <td class="text-muted-foreground px-4 py-3 align-top">{{ row.linear }}</td>
              <td class="bg-primary/6 px-4 py-3 align-top">{{ row.trama }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ComparisonTable {
  protected readonly rows = COMPARISON;
}
