import { Injectable, Logger } from '@nestjs/common';
import { TokensService } from '../auth/tokens.service.js';
import type { WorkspaceContext } from '../auth/request-context.js';
import { API_PERMISSIONS } from '../contracts/domain.js';
import type { ApiPermission } from '../contracts/domain.js';
import { record, type AiToolDef } from './ai-provider.js';

/** Name of the short-lived tokens minted for a chat turn (hidden from the tokens list). */
export const ASSISTANT_TOKEN_NAME = 'Assistant (temporary)';

/** Access management and workspace destruction stay out of the model's reach, whatever the user's role. */
const WITHHELD: readonly ApiPermission[] = [
  'tokens:read',
  'tokens:write',
  'tokens:delete',
  'members:write',
  'members:delete',
  'integrations:write',
  'integrations:delete',
  'outgoing-webhooks:write',
  'outgoing-webhooks:delete',
  'workspace:delete',
];
export const ASSISTANT_PERMISSIONS: ApiPermission[] = API_PERMISSIONS.filter((p) => !WITHHELD.includes(p));

/** Per-token burst caps for one chat turn (the daily cap is enforced per user by AiService). */
const TOKEN_LIMITS = { requestsPerMinute: 120, writesPerMinute: 20, writesPerDay: 200 };
const TOKEN_TTL_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = 20_000;
const MAX_TOOL_RESULT_CHARS = 12_000;
/** The generic REST escape hatch is not offered to the model; dedicated tools cover the product. */
const HIDDEN_TOOLS = new Set(['api_request']);

export interface McpTool extends AiToolDef {
  readOnly: boolean;
}

export interface McpSession {
  tools: McpTool[];
  /** Runs a tool and returns text for the model, plus whether it failed. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
}

/**
 * Lets the assistant use the same MCP server external clients use. Each chat turn gets a temporary
 * `custom` API token (acting as the user, so their role still applies, with the permissions above and
 * tight burst caps), which is deleted when the turn ends.
 */
@Injectable()
export class AssistantToolsService {
  private readonly log = new Logger(AssistantToolsService.name);
  private readonly url = process.env.MCP_URL?.trim() || undefined;

  constructor(private readonly tokens: TokensService) {}

  enabled(): boolean {
    return !!this.url;
  }

  async withSession<T>(userId: string, ctx: WorkspaceContext, signal: AbortSignal, action: (s: McpSession) => Promise<T>): Promise<T> {
    const { token, secret } = await this.tokens.create({
      workspaceId: ctx.workspace.id,
      name: ASSISTANT_TOKEN_NAME,
      actor: { type: 'user', id: userId },
      scope: 'custom',
      permissions: ASSISTANT_PERMISSIONS,
      limits: TOKEN_LIMITS,
      createdByUserId: userId,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });
    try {
      return await action(await this.open(secret, signal));
    } finally {
      await this.tokens.revoke(token.id).catch((e: unknown) => this.log.warn(`could not delete temporary token: ${String(e)}`));
    }
  }

  private async open(secret: string, signal: AbortSignal): Promise<McpSession> {
    const url = this.url!;
    let id = 0;
    const rpc = async (method: string, params: unknown, requestSignal: AbortSignal = signal): Promise<Record<string, unknown>> => {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.any([requestSignal, AbortSignal.timeout(RPC_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`MCP server answered HTTP ${response.status}`);
      }
      const body = record(await response.json());
      const error = record(body?.['error']);
      if (error) throw new Error(`MCP error: ${String(error['message'])}`);
      const result = record(body?.['result']);
      if (!result) throw new Error('MCP server sent an invalid reply');
      return result;
    };

    const listed = (await rpc('tools/list', {}))['tools'];
    const tools: McpTool[] = [];
    for (const entry of Array.isArray(listed) ? listed : []) {
      const t = record(entry);
      if (!t || typeof t['name'] !== 'string' || HIDDEN_TOOLS.has(t['name'])) continue;
      tools.push({
        name: t['name'],
        description: typeof t['description'] === 'string' ? t['description'] : '',
        parameters: record(t['inputSchema']) ?? { type: 'object', properties: {} },
        readOnly: record(t['annotations'])?.['readOnlyHint'] === true,
      });
    }

    return {
      tools,
      call: async (name, args, callSignal) => {
        const result = await rpc('tools/call', { name, arguments: args }, callSignal);
        const content = Array.isArray(result['content']) ? result['content'] : [];
        const text = content
          .map((c) => record(c))
          .filter((c) => c?.['type'] === 'text')
          .map((c) => String(c?.['text'] ?? ''))
          .join('\n');
        return {
          text: text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… [truncated; use filters to narrow the query]` : text,
          isError: result['isError'] === true,
        };
      },
    };
  }
}
