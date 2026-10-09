import { BadRequestException, Injectable } from '@nestjs/common';
import { EXTERNAL_PROVIDER_META, type ActorRef, type ExternalProvider } from '../contracts/domain.js';
import { HttpClient } from '../integrations/http-client.js';
import { IssuesService } from '../issues/issues.service.js';
import { CredentialsService, createAdapter, providerFailure } from './credentials.service.js';
import { externalRefOf, githubIssueId, parseExternalUrl } from './mapping.js';
import type { ExternalIssue } from './types.js';

/** Link an existing Trama issue to an issue in GitHub or Linear and keep a read-only mirror of its status. */
@Injectable()
export class ExternalLinksService {
  constructor(
    private readonly http: HttpClient,
    private readonly credentials: CredentialsService,
    private readonly issues: IssuesService,
  ) {}

  private async read(workspaceId: string, provider: ExternalProvider, host: string, lookup: { repository?: string; id: string }): Promise<ExternalIssue> {
    const label = EXTERNAL_PROVIDER_META[provider].label;
    const cred = await this.credentials.forHost(workspaceId, provider, host);
    try {
      const adapter = createAdapter(this.http, provider, cred, { repository: lookup.repository });
      return await adapter.getIssue(lookup.id);
    } catch (e) {
      const failure = providerFailure(label, e, [cred.token]);
      if (!cred.token && provider === 'github' && failure instanceof BadRequestException)
        throw new BadRequestException(`${label} could not read that issue without a token. If the repository is private, add a credential under Settings → Import.`);
      throw failure;
    }
  }

  async link(workspaceId: string, actor: ActorRef, idOrKey: string, url: string) {
    const parsed = parseExternalUrl(url);
    if (!parsed) throw new BadRequestException('Paste the URL of a GitHub issue (https://github.com/owner/repo/issues/12) or a Linear issue');
    const lookup =
      parsed.provider === 'github'
        ? { repository: parsed.repository, id: githubIssueId(parsed.repository!, parsed.number!) }
        : { id: parsed.identifier! };
    const ext = await this.read(workspaceId, parsed.provider, parsed.host, lookup);
    return this.issues.setExternalRef(workspaceId, actor, idOrKey, externalRefOf(parsed.provider, ext, 'link'));
  }

  /** Re-reads the external status. The Trama status is never touched. */
  async refresh(workspaceId: string, idOrKey: string) {
    const issue = await this.issues.get(workspaceId, idOrKey);
    const ref = issue.externalRef;
    if (!ref) throw new BadRequestException('This issue is not linked to an external issue');
    const parsed = parseExternalUrl(ref.url);
    const host = parsed?.host ?? new URL(ref.url).hostname.toLowerCase();
    const repository = ref.provider === 'github' ? ref.id.slice(0, ref.id.lastIndexOf('#')) : undefined;
    const ext = await this.read(workspaceId, ref.provider, host, { repository, id: ref.id });
    const next = externalRefOf(ref.provider, ext, ref.origin);
    return this.issues.refreshExternalRef(workspaceId, idOrKey, {
      state: next.state,
      stateType: next.stateType,
      syncedAt: next.syncedAt,
      key: next.key,
      url: next.url,
    });
  }

  unlink(workspaceId: string, actor: ActorRef, idOrKey: string) {
    return this.issues.setExternalRef(workspaceId, actor, idOrKey, null);
  }
}
