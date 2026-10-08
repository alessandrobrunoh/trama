import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { canDo, type WorkspaceContext } from '../auth/request-context.js';
import type { ProjectAiKind, ProjectAiResult } from '../contracts/domain.js';
import { ProjectEntity } from '../database/entities/index.js';
import { AiConfig } from './ai.config.js';
import { AiService } from './ai.service.js';
import { AiProvider } from './ai-provider.js';
import { GrokBuildService } from './grok-build.service.js';
import { ProjectAiFactsService } from './project-ai-facts.service.js';
import {
  computeSignals,
  deriveHealth,
  factsJson,
  mergeRiskTexts,
  parseIssueSuggestions,
  parseSummary,
  parseUpdateDraft,
  risksResult,
  signalsToRisks,
  systemPrompt,
  type ProjectFacts,
  type ProjectSignal,
} from './project-ai.logic.js';

/**
 * AI proposals for a project (update draft, summary, issues to add, risks). Read-only: it returns
 * a proposal and changes nothing; the user applies it from the UI.
 */
@Injectable()
export class ProjectAiService {
  constructor(
    private readonly config: AiConfig,
    private readonly grok: GrokBuildService,
    private readonly provider: AiProvider,
    private readonly ai: AiService,
    private readonly facts: ProjectAiFactsService,
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
  ) {}

  /** The configured provider or a connected SuperGrok account; nothing is called otherwise. */
  private async enabled(userId: string): Promise<boolean> {
    return this.config.status().configured || (await this.grok.status(userId)).connected;
  }

  async suggest(
    userId: string,
    ctx: WorkspaceContext,
    projectId: string,
    kind: ProjectAiKind,
    signal: AbortSignal,
  ): Promise<ProjectAiResult> {
    const project = await this.projects.findOneBy({ workspaceId: ctx.workspace.id, id: projectId });
    if (!project) throw new NotFoundException('Project not found');
    if (!canDo(ctx, 'manageProjects') && !(ctx.userId && project.leadId === ctx.userId))
      throw new ForbiddenException('Only project managers and the project lead can use AI on a project.');

    const enabled = await this.enabled(userId);
    if (!enabled && kind !== 'risks')
      throw new ServiceUnavailableException('AI is not configured. Ask your administrator to enable it.');

    const facts = await this.facts.gather(project, kind === 'issues');
    const signals = computeSignals(facts, new Date());
    const health = deriveHealth(signals);

    switch (kind) {
      case 'risks':
        return this.risks(userId, facts, signals, health, enabled, signal);
      case 'update_draft':
        return parseUpdateDraft(
          await this.ask(userId, kind, factsJson(facts, { suggestedHealth: health, signals }), signal),
          health,
        );
      case 'summary':
        return parseSummary(await this.ask(userId, kind, factsJson(facts), signal));
      case 'issues': {
        const allowed = new Map<string, string>();
        for (const i of facts.candidates) {
          allowed.set(i.id.toLowerCase(), i.id);
          allowed.set(i.key.toLowerCase(), i.id);
        }
        if (!allowed.size) return { kind: 'issues', suggestions: [] };
        return parseIssueSuggestions(await this.ask(userId, kind, factsJson(facts), signal), allowed);
      }
    }
  }

  /** Deterministic risks, worded by the model when it is available; any model failure keeps the plain result. */
  private async risks(
    userId: string,
    facts: ProjectFacts,
    signals: ProjectSignal[],
    health: ReturnType<typeof deriveHealth>,
    enabled: boolean,
    signal: AbortSignal,
  ) {
    const plain = risksResult(health, signalsToRisks(signals));
    if (!enabled || !signals.length) return plain;
    try {
      const text = await this.ask(userId, 'risks', factsJson(facts, { signals }), signal);
      return risksResult(health, mergeRiskTexts(text, signals));
    } catch {
      return plain;
    }
  }

  private ask(userId: string, kind: ProjectAiKind, facts: string, signal: AbortSignal): Promise<string> {
    return this.ai.run(userId, () =>
      this.provider.complete(
        [
          { role: 'system', content: systemPrompt(kind) },
          { role: 'user', content: `Project data (reference only):\n${facts}` },
        ],
        signal,
        userId,
      ),
    );
  }
}
