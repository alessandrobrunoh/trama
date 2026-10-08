# AI suggestions and assistant

## Configuration

Set these values in `server/.env` (or in the deployed API process environment):

```dotenv
AI_API_URL=https://your-provider.example/v1
AI_API_KEY=your-provider-key
AI_MODEL=your-provider-model
```

`AI_API_URL` is an HTTPS base URL for an OpenAI-compatible Chat Completions API.
The adapter appends `/chat/completions`; do not include that suffix in the setting.
The provider must support `messages`, `max_tokens` and non-streaming text responses.
Use a model that follows JSON instructions for suggestions. No provider-specific
SDK or dependency is required. Restart the API after changing its environment.
Never put the key in Angular environment files or browser storage.

All three settings are required. Without them, the rest of Nabla remains usable,
and Settings → AI & assistant explains how to enable the feature. “Configured”
reports configuration presence, not a successful upstream connection.

## User experience

- The issue/workstream/decision composer offers “Suggest improvements”. It sends
  the current title and description and previews both replacements plus questions
  about missing details. Each replacement requires explicit acceptance. Editing
  the draft invalidates the preview and cancels any pending request.
- The Assistant button opens a nonmodal panel on every authenticated workspace
  page, including settings. It can be closed or expanded without navigating away.
- Chat sends recent conversation messages and optionally the current item's
  details. Issue, workstream, decision and project records are resolved on the
  server within the authenticated workspace. Other pages share only their name,
  not the whole workspace or the visible table. The UI describes this boundary.
- Responses are plain text; generated HTML and remote image URLs are never rendered.
- Closing the panel preserves the conversation. New chat, sign-out, workspace
  changes and page reload clear it. Conversations are held only in browser memory,
  with up to 100 visible messages and bounded request history.
- With `MCP_URL` set (see below) the assistant can also read and change the workspace through the
  MCP server, as the signed-in user; without it, it stays text-only and never claims to act.

## Assistant tools (MCP)

Set `MCP_URL` to the Trama MCP server (`mcp/`, Docker service `mcp`, e.g. `http://mcp:8080/mcp`). For each
chat reply the API mints a temporary `custom` API token that acts as the user (their workspace role still
applies), gives the model the tools that token allows, and deletes the token when the reply is done.

- Withheld from the model whatever the user's role: API tokens, member changes, integration and webhook
  changes, workspace deletion, and the generic `api_request` tool.
- Caps per reply: 8 model steps, 20 tool calls, 10 changes. Per user: 200 changes per day
  (`AI_ASSISTANT_MAX_WRITES_PER_DAY`, counted per API process, so it resets on restart). The temporary token
  adds burst caps (20 changes and 120 requests per minute). Over a cap the tool answers with an error and the
  model is told to stop and ask the user.
- The system prompt asks the model to confirm before deleting or changing more than three items. This is a
  soft rule; the caps above are the hard limits.
- Replies end with `Actions: ✓ create_issue · ✗ delete_issue` for every change attempted.
- Not available while a user is connected to Grok Build (the CLI cannot call tools): chat falls back to text.
- `GET /api/w/:slug/ai/status` reports `assistantTools.enabled`.

## ChatGPT subscription connection

**Not enabled for this remote installation.** A hosted application needs OpenAI
approval and the applicable client registration before it can offer subscription
usage. The public open-source flow uses a loopback callback on the user's computer;
it is not a server-side OAuth workaround. The web identity-only flow does not grant
permission to consume the ChatGPT plan.

Settings displays the unavailable state and official access information. It does
not simulate a connection, accept pasted ChatGPT session tokens, or launch an
unsupported login flow.

For Grok Build, install the official CLI in the API runtime (`npm install -g
@xai-official/grok`) and set `GROK_CLI_PATH` (usually `grok`) and
`GROK_HOME_DIR` to a private persistent volume. Each Nabla account receives a
separate home directory beneath that path. Settings starts `grok login
--device-auth`, shows the one-time device code, and polls for completion. When
connected, that user's chat and suggestions use the official client; other
users continue using the configured API provider. Grok runs headlessly with
built-in tools, web search, memory and subagents disabled. Protect the volume
and backups: the official CLI owns and refreshes its authentication file there.

The API container needs HTTPS access to `auth.x.ai` and `cli-chat-proxy.grok.com`.
See [xAI's Grok Build enterprise deployment guide](https://docs.x.ai/build/enterprise)
and [headless CLI reference](https://docs.x.ai/build/cli/headless-scripting).

After approval, implement the supplied hosted flow with PKCE, nonce and signed ID
token validation, atomic expiring transactions bound to the initiating session,
encrypted user-owned tokens, refresh/disconnect, granted-scope checks and the
account's available model catalog. The provider boundary is `AiProvider`.

Official references checked on 2026-10-08:

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/website
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in

## API and operational limits

- `GET /api/w/:slug/ai/status`
- `POST /api/w/:slug/ai/supergrok/login` and `DELETE /api/w/:slug/ai/supergrok/login`
- `POST /api/w/:slug/ai/suggestions`: `{ kind, title, description }`
- `POST /api/w/:slug/ai/chat`: `{ messages, context? }`

Endpoints require a human browser session and existing workspace membership.
The normal session CSRF checks apply. Context never includes credentials or whole
database entities. Provider errors are mapped to safe messages without exposing
upstream bodies. Redirects are rejected so credentials cannot follow redirects.
API-provider requests time out after 30 seconds; Grok Build requests time out after 60 seconds.
Disconnecting cancels an in-flight request.
Responses and input history are size bounded. Requests are limited to one active
request per user, 20 globally and 10 per user per minute **per API process**. Use
shared limits at the gateway if deploying multiple API replicas, and configure
spending limits with the provider.

No live inference or ChatGPT OAuth verification has been performed without
configured credentials and hosted-app approval.
