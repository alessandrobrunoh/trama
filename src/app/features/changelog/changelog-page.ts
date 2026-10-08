import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon } from '@lucide/angular';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';

type ChangeKind = 'new' | 'improved' | 'fixed';

interface ChangelogEntry {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  title: string;
  summary: string;
  changes: { kind: ChangeKind; text: string }[];
}

/** `/changelog`: public release notes, newest first. Add an entry when something user-visible ships. */
@Component({
  selector: 'app-changelog-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideDynamicIcon, SiteHeader, SiteFooter],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="mx-auto w-full max-w-4xl flex-1 px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <p class="text-primary text-[13px] font-medium">Changelog</p>
      <h1 class="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
        What's new in Trama
      </h1>
      <p class="text-muted-foreground mt-4 max-w-xl text-[15px] leading-relaxed">
        Every user-visible change, newest first.
      </p>
      <a
        routerLink="/roadmap"
        class="text-primary mt-5 inline-flex items-center gap-1 text-[13px] font-medium"
      >
        See what's coming next <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
      </a>

      <ol class="mt-14 flex flex-col">
        @for (entry of entries; track entry.title) {
          <li class="border-border grid gap-4 border-t py-10 sm:grid-cols-[10rem_1fr] sm:gap-8">
            <time [attr.datetime]="entry.date" class="text-muted-foreground text-[13px] sm:pt-1.5">
              {{ entry.date | date: 'MMMM d, y' }}
            </time>
            <article>
              <h2 class="text-2xl font-semibold tracking-[-0.02em]">{{ entry.title }}</h2>
              <p class="text-muted-foreground mt-2 text-[15px] leading-relaxed">
                {{ entry.summary }}
              </p>
              <ul class="mt-5 flex flex-col gap-2.5 text-[14px] leading-relaxed">
                @for (c of entry.changes; track c.text) {
                  <li class="flex items-start gap-3">
                    <span
                      class="mt-0.5 w-[4.5rem] shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-medium"
                      [class]="badge[c.kind]"
                      >{{ label[c.kind] }}</span
                    >
                    <span>{{ c.text }}</span>
                  </li>
                }
              </ul>
            </article>
          </li>
        }
      </ol>
    </main>

    <app-site-footer />
  `,
})
export class ChangelogPage {
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly label: Record<ChangeKind, string> = {
    new: 'New',
    improved: 'Improved',
    fixed: 'Fixed',
  };
  protected readonly badge: Record<ChangeKind, string> = {
    new: 'bg-primary/12 text-primary',
    improved: 'bg-tone-blue/12 text-tone-blue',
    fixed: 'bg-tone-green/12 text-tone-green',
  };

  protected readonly entries: ChangelogEntry[] = [
    {
      date: '2026-10-08',
      title: 'A public home for Trama',
      summary: 'Trama now has a landing page, a blog, a public roadmap and this changelog.',
      changes: [
        {
          kind: 'new',
          text: 'Landing page at / for signed-out visitors, with a side-by-side comparison with Trello, Jira and Linear.',
        },
        {
          kind: 'new',
          text: 'Blog, starting with “Introducing Trama” and “Trama vs Trello, Jira and Linear”.',
        },
        { kind: 'new', text: 'Public roadmap and changelog.' },
        {
          kind: 'improved',
          text: 'Account creation moved to /register; old /signup links keep working.',
        },
      ],
    },
    {
      date: '2026-10-08',
      title: 'Agents, assistant and scoped tokens',
      summary: 'Agents get precise permissions, and the assistant is one keystroke away.',
      changes: [
        {
          kind: 'new',
          text: 'API tokens with fine-grained resource × action permissions and usage caps.',
        },
        {
          kind: 'new',
          text: 'Assistant popup with chat history, a full-page view and unread markers for replies that arrive out of sight.',
        },
        { kind: 'new', text: 'Command palette with Ask Trama and chord shortcuts.' },
        { kind: 'new', text: 'Draft status for issues, workstreams and decisions.' },
        { kind: 'improved', text: 'Compact composer with instant quick suggestions.' },
      ],
    },
    {
      date: '2026-10-08',
      title: 'Workstreams grow up',
      summary: 'Plan, sequence and unblock outcomes, and see the whole workspace at a glance.',
      changes: [
        {
          kind: 'new',
          text: 'Milestones, timeline, dependencies and input requests on workstreams.',
        },
        { kind: 'new', text: 'Overview dashboard, statistics, My Work and activity feed.' },
        {
          kind: 'new',
          text: 'Roles, agents, tokens, integrations, projects and teams in settings, plus outgoing webhooks.',
        },
        { kind: 'new', text: 'Installable mobile experience (PWA).' },
        { kind: 'new', text: 'Customizable sidebar: visibility, order and badge style.' },
        {
          kind: 'improved',
          text: 'Inline editing, bulk actions and a richer issue page; board drag-and-drop for issues and workstreams.',
        },
        {
          kind: 'improved',
          text: 'Linear-style design tokens, Inter typography and a calmer app shell.',
        },
        { kind: 'fixed', text: 'The workstream issues tab now uses the full width.' },
      ],
    },
    {
      date: '2026-10-07',
      title: 'First commit',
      summary:
        'The first version of Trama: issues, workstreams, decisions and artifacts in one workspace.',
      changes: [
        {
          kind: 'new',
          text: 'Issues, workstreams, decisions and artifacts, with an API and PostgreSQL storage.',
        },
        { kind: 'new', text: 'Workspaces, teams, projects and saved views.' },
      ],
    },
  ];
}
