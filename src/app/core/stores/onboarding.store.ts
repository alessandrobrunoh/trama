// Activation checklist of a workspace: six first steps from "nothing here yet" to "an agent is working".
//
// Progress is derived from real data wherever there is some (a team exists, a workstream has acceptance
// criteria, a token was used…). Only what has no trace in the workspace is remembered: dismissal and "tried
// the command bar". There is no per-user settings endpoint, so those live in this browser, per user and workspace.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Capability } from '../contracts/domain';
import { InvitesStore } from './invites.store';
import { NablaStore } from './nabla.store';
import { readJson, writeJson } from './storage';
import { UiStore } from './ui.store';

export const ONBOARDING_STORAGE_KEY = 'trama.onboarding.v1';

export type OnboardingStepId = 'team' | 'invite' | 'repository' | 'workstream' | 'agent' | 'command-bar';

/** What clicking the step's button does: open a dialog, or go to a page under the workspace. */
export type OnboardingAction =
  | { kind: 'create'; what: 'team' | 'repository' | 'workstream' }
  | { kind: 'link'; path: string[] }
  | { kind: 'command-bar' };

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  cta: string;
  action: OnboardingAction;
  done: boolean;
}

interface Remembered {
  dismissed?: boolean;
  commandBar?: boolean;
}
type Persisted = Record<string, Remembered>;

/** Steps that need a capability the person may not have; they are left out unless already done. */
const NEEDS: Partial<Record<OnboardingStepId, Capability>> = {
  team: 'createTeams',
  invite: 'inviteMembers',
  repository: 'manageRepositories',
  workstream: 'createWorkstreams',
  agent: 'manageTokens',
};

@Injectable({ providedIn: 'root' })
export class OnboardingStore {
  private readonly nabla = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly invites = inject(InvitesStore);

  private readonly remembered = signal<Persisted>((readJson<Persisted>(ONBOARDING_STORAGE_KEY) ?? {}) as Persisted);

  /** One entry per person and workspace. */
  private readonly key = computed(() => {
    const me = this.nabla.me()?.id;
    const slug = this.nabla.slug();
    return me && slug ? `${me}:${slug}` : null;
  });
  private readonly mine = computed<Remembered>(() => {
    const key = this.key();
    return (key && this.remembered()[key]) || {};
  });

  readonly dismissed = computed(() => !!this.mine().dismissed);

  readonly steps = computed<OnboardingStep[]>(() => {
    const s = this.nabla;
    const mine = this.mine();
    const hasCriteria = s.workstreams().some((w) => w.acceptanceCriteria.length > 0);
    const agentConnected =
      s.agents().length > 0 || s.tokens().some((t) => !!t.lastUsedAt && t.actor.id === s.me()?.id);
    const defs: OnboardingStep[] = [
      {
        id: 'team',
        title: 'Create a team',
        description: 'A team owns work and gives it a key like WEB-12.',
        cta: 'Create team',
        action: { kind: 'create', what: 'team' },
        done: s.teams().length > 0,
      },
      {
        id: 'invite',
        title: 'Invite a teammate',
        description: 'Work is easier with someone to hand a question to.',
        cta: 'Invite',
        action: { kind: 'link', path: ['settings', 'members'] },
        done: s.members().length > 1 || this.invites.invites().length > 0,
      },
      {
        id: 'repository',
        title: 'Connect a repository',
        description: 'Pull requests and checks on it move workstreams forward by themselves.',
        cta: 'Add repository',
        action: { kind: 'create', what: 'repository' },
        done: s.repositories().length > 0,
      },
      {
        id: 'workstream',
        title: 'Create your first workstream',
        description: 'An outcome with acceptance criteria. Its status follows the facts, not drag and drop.',
        cta: 'New workstream',
        action: { kind: 'create', what: 'workstream' },
        done: hasCriteria,
      },
      {
        id: 'agent',
        title: 'Connect your agent',
        description: 'Give Claude Code, Cursor or the CLI a narrow token so it can read and report here.',
        cta: 'Connect',
        action: { kind: 'link', path: ['connect'] },
        done: agentConnected,
      },
      {
        id: 'command-bar',
        title: 'Try the command bar',
        description: 'Press ⌘K to jump anywhere, search, or create without leaving the keyboard.',
        cta: 'Open ⌘K',
        action: { kind: 'command-bar' },
        done: !!mine.commandBar,
      },
    ];
    return defs.filter((d) => d.done || !NEEDS[d.id] || s.allowed(NEEDS[d.id]!));
  });

  readonly doneCount = computed(() => this.steps().filter((x) => x.done).length);
  readonly total = computed(() => this.steps().length);
  readonly complete = computed(() => this.total() > 0 && this.doneCount() === this.total());
  /** The first step still to do: what the checklist highlights. */
  readonly next = computed(() => this.steps().find((x) => !x.done) ?? null);
  /** Shown to people who have not dismissed it, once the workspace has loaded. */
  readonly visible = computed(() => this.nabla.ready() && !!this.key() && !this.dismissed() && this.total() > 0);

  constructor() {
    // Pending invitations are not part of the snapshot: load them once for people who may invite.
    effect(() => {
      if (!this.nabla.ready() || !this.nabla.allowed('inviteMembers')) return;
      untracked(() => void this.invites.load());
    });
    // Tokens are loaded on demand too; a used token is the proof that an agent is connected.
    effect(() => {
      if (!this.nabla.ready() || !this.nabla.allowed('manageTokens') || this.dismissed()) return;
      untracked(() => void this.nabla.loadTokens());
    });
    // Opening the command bar is the whole of the last step.
    effect(() => {
      if (this.ui.modal() === 'command') untracked(() => this.patch({ commandBar: true }));
    });
    // "Setup checklist" in the help menu.
    effect(() => {
      if (this.ui.checklistRequests() > 0) untracked(() => this.patch({ dismissed: false }));
    });
    effect(() => writeJson(ONBOARDING_STORAGE_KEY, this.remembered()));
  }

  dismiss(): void {
    this.patch({ dismissed: true });
  }

  /** Brings the checklist back (help menu, command bar). */
  restore(): void {
    this.patch({ dismissed: false });
  }

  private patch(change: Remembered): void {
    const key = this.key();
    if (!key) return;
    this.remembered.update((all) => ({ ...all, [key]: { ...all[key], ...change } }));
  }
}
