import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { AttentionItem, AttentionKind } from '../contracts/domain.js';
import {
  ArtifactEntity,
  AttentionStateEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
} from '../database/entities/index.js';
import {
  canView,
  currentAccess,
  projectHidden,
} from '../auth/member-access.js';
import { In, type Repository } from 'typeorm';

@Injectable()
export class AttentionService {
  constructor(
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
    @InjectRepository(InputRequestEntity)
    private readonly requests: Repository<InputRequestEntity>,
    @InjectRepository(DecisionEntity)
    private readonly decisions: Repository<DecisionEntity>,
    @InjectRepository(ArtifactEntity)
    private readonly artifacts: Repository<ArtifactEntity>,
    @InjectRepository(AttentionStateEntity)
    private readonly states: Repository<AttentionStateEntity>,
  ) {}

  async list(
    workspaceId: string,
    userId: string,
    snapshotRows?: { issues: IssueEntity[]; artifacts: ArtifactEntity[] },
  ): Promise<AttentionItem[]> {
    const access = currentAccess();
    if (!canView('issues', access)) return [];

    const issueRows =
      snapshotRows?.issues ?? (await this.issues.findBy({ workspaceId }));
    const visibleIssues = issueRows.filter(
      (issue) => !projectHidden(access, issue.projectId),
    );
    const issueIds = new Set(visibleIssues.map((issue) => issue.id));
    if (issueIds.size === 0) return [];
    const issueById = new Map(visibleIssues.map((issue) => [issue.id, issue]));
    const items: AttentionItem[] = [];

    if (canView('input-requests', access)) {
      const requests = await this.requests.find({
        where: { workspaceId, issueId: In([...issueIds]), state: 'open' },
      });
      for (const request of requests) {
        if (request.assigneeUserId && request.assigneeUserId !== userId)
          continue;
        const issue = issueById.get(request.issueId!);
        if (!issue) continue;
        items.push({
          id: `input_requested:${request.id}`,
          kind: 'input_requested',
          severity: 'medium',
          title: request.question,
          detail: `Question on ${issue.key}: ${issue.title}`,
          issueId: issue.id,
          inputRequestId: request.id,
          since: request.createdAt.toISOString(),
          state: 'open',
        });
      }
    }

    if (canView('decisions', access)) {
      const decisions = await this.decisions.find({
        where: {
          workspaceId,
          originIssueId: In([...issueIds]),
          status: 'proposed',
        },
      });
      for (const decision of decisions) {
        const issue = issueById.get(decision.originIssueId!);
        if (!issue) continue;
        items.push({
          id: `needs_decision:${decision.id}`,
          kind: 'needs_decision',
          severity: 'medium',
          title: decision.title,
          detail: `Proposed decision on ${issue.key}: ${decision.statement}`,
          issueId: issue.id,
          decisionId: decision.id,
          since: decision.createdAt.toISOString(),
          state: 'open',
        });
      }
    }

    if (canView('artifacts', access)) {
      const artifacts =
        snapshotRows?.artifacts ??
        (await this.artifacts.find({
          where: [
            {
              workspaceId,
              issueId: In([...issueIds]),
              review: 'requested',
            },
            {
              workspaceId,
              issueId: In([...issueIds]),
              ci: 'failing',
            },
          ],
        }));
      for (const artifact of artifacts) {
        const issue = issueById.get(artifact.issueId!);
        if (!issue) continue;
        if (artifact.review === 'requested') {
          items.push(
            this.artifactItem(
              'review_requested',
              artifact,
              issue,
              'Review requested',
            ),
          );
        }
        if (artifact.ci === 'failing') {
          items.push(
            this.artifactItem('ci_failed', artifact, issue, 'CI failing'),
          );
        }
      }
    }

    const itemIds = items.map((item) => item.id);
    const saved = itemIds.length
      ? await this.states.findBy({ workspaceId, userId, itemId: In(itemIds) })
      : [];
    const stateById = new Map(saved.map((state) => [state.itemId, state]));
    return items
      .map((item) => {
        const state = stateById.get(item.id);
        if (!state || state.since.getTime() !== new Date(item.since).getTime())
          return item;
        if (
          state.state === 'snoozed' &&
          state.snoozedUntil &&
          state.snoozedUntil <= new Date()
        )
          return item;
        return {
          ...item,
          state: state.state,
          ...(state.snoozedUntil
            ? { snoozedUntil: state.snoozedUntil.toISOString() }
            : {}),
        };
      })
      .sort((a, b) => {
        const severity = { high: 0, medium: 1, low: 2 };
        return (
          severity[a.severity] - severity[b.severity] ||
          new Date(a.since).getTime() - new Date(b.since).getTime()
        );
      });
  }

  async dismiss(
    workspaceId: string,
    userId: string,
    itemId: string,
  ): Promise<void> {
    const item = (await this.list(workspaceId, userId)).find(
      (candidate) => candidate.id === itemId,
    );
    if (!item) throw new NotFoundException('Attention item not found');
    await this.saveState(workspaceId, userId, item, 'dismissed', null);
  }

  async snooze(
    workspaceId: string,
    userId: string,
    itemId: string,
    until: string,
  ): Promise<void> {
    const snoozedUntil = new Date(until);
    if (!Number.isFinite(snoozedUntil.getTime()) || snoozedUntil <= new Date())
      throw new BadRequestException('snoozedUntil must be a future date');
    const item = (await this.list(workspaceId, userId)).find(
      (candidate) => candidate.id === itemId,
    );
    if (!item) throw new NotFoundException('Attention item not found');
    await this.saveState(workspaceId, userId, item, 'snoozed', snoozedUntil);
  }

  async restore(
    workspaceId: string,
    userId: string,
    itemId: string,
  ): Promise<AttentionItem> {
    const item = (await this.list(workspaceId, userId)).find(
      (candidate) => candidate.id === itemId,
    );
    if (!item) throw new NotFoundException('Attention item not found');
    await this.states.delete({ workspaceId, userId, itemId });
    return { ...item, state: 'open', snoozedUntil: undefined };
  }

  private artifactItem(
    kind: Extract<AttentionKind, 'review_requested' | 'ci_failed'>,
    artifact: ArtifactEntity,
    issue: IssueEntity,
    message: string,
  ): AttentionItem {
    return {
      id: `${kind}:${artifact.id}`,
      kind,
      severity: kind === 'ci_failed' ? 'high' : 'medium',
      title: artifact.title,
      detail: `${message} on ${issue.key}: ${issue.title}`,
      artifactId: artifact.id,
      issueId: issue.id,
      since: artifact.updatedAt.toISOString(),
      state: 'open',
    };
  }

  private async saveState(
    workspaceId: string,
    userId: string,
    item: AttentionItem,
    state: AttentionStateEntity['state'],
    snoozedUntil: Date | null,
  ): Promise<void> {
    await this.states.save({
      workspaceId,
      userId,
      itemId: item.id,
      state,
      snoozedUntil,
      since: new Date(item.since),
    });
  }
}
