// ApiClient — typed wrapper over the Trama REST API (PLAN.md §4). Promise-based.
//
// - Base URL `/api` (API_BASE_URL); cookie session; `X-Client-Id` on writes (apiInterceptor).
// - Every call rejects with `ApiError`. Side effects of failures (done once, here):
//     401 (except login, signup, logout) -> `sessionExpired` fires; SessionStore clears the session
//                                  and redirects to /login?next=... A rejected /auth/me is a dead
//                                  session. Wrong-password and logout 401s are not.
//     403                       -> toast "You don't have permission" (the ApiError is still thrown)
// - Pass `{ quiet: true }` as the last argument of a method that supports it to skip the 403 toast.
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Subject, firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config';
import type {
  Agent,
  AttentionItem,
  Artifact,
  ApiToken,
  Comment,
  CommentPage,
  SnapshotCommentsMode,
  DomainEvent,
  Favorite,
  ImportCredential,
  ImportJob,
  ImportPreview,
  FavoriteType,
  ID,
  NotificationKind,
  NotificationChannels,
  NotificationList,
  NotificationSettings,
  InviteLink,
  InvitePreview,
  Issue,
  Membership,
  Milestone,
  OutgoingWebhook,
  Project,
  ProjectAiKind,
  ProjectAiResult,
  Role,
  PublicView,
  SavedView,
  User,
  WebhookDeliveryLog,
  Workspace,
  WorkspaceInvite,
  WorkspaceSnapshot,
} from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { ApiError } from './api-error';
import type {
  AddMemberInput,
  CreateImportCredentialInput,
  ImportTargetInput,
  StartImportInput,
  AttentionQuery,
  CreateAgentInput,
  CreateCommentInput,
  CreateInviteInput,
  CreateMilestoneInput,
  UpdateMilestoneInput,
  BulkIssuePatch,
  CreateIssueInput,
  CreateIntegrationInput,
  IntegrationDetail,
  IntegrationWithWebhook,
  UpdateIntegrationInput,
  CreateProjectInput,
  CreateTokenInput,
  CreatedToken,
  CreateViewInput,
  InviteViewInput,
  CreateWorkspaceInput,
  EventsQuery,
  LoginInput,
  MeResponse,
  SearchResults,
  SignupInput,
  UpdateAgentInput,
  UpdateIssueInput,
  UpdateMemberInput,
  UpdateProjectInput,
  UpdateViewInput,
  UpdateWorkspaceInput,
  CreateLabelInput,
  CreateStatusInput,
  CreateWebhookInput,
  UpdateLabelInput,
  UpdateStatusInput,
  MergeLabelInput,
  UpdateWebhookInput,
  UpdateWorkspaceSettingsInput,
  RoleInput,
  UpdateRoleInput,
  WebhookWithSecret,
  ManualTimeEntryInput,
  TimeEntry,
  TimeEntryTarget,
} from './api.types';

export interface RequestOptions {
  /** Skip the global "no permission" toast on 403. */
  quiet?: boolean;
}

type Params = Record<string, string | number | boolean | undefined | null>;

/** Accept either a bare entity or `{ [key]: entity }`. */
function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === 'object' && !Array.isArray(res) && key in (res as object)) {
    return (res as Record<string, T>)[key];
  }
  return res as T;
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly notifier = inject(Notifier);
  readonly baseUrl = inject(API_BASE_URL).replace(/\/$/, '');

  /** Emits when the server rejects the session (401, other than login, signup or logout). */
  readonly sessionExpired = new Subject<void>();

  // ───────────────────────── core ─────────────────────────

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    init: {
      body?: unknown;
      params?: Params;
      text?: boolean;
      accept?: string;
      quiet?: boolean;
    } = {},
  ): Promise<T> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(init.params ?? {})) {
      if (v !== undefined && v !== null && v !== '') params = params.set(k, String(v));
    }
    const headers = init.accept ? { Accept: init.accept } : undefined;
    const url = `${this.baseUrl}${path}`;
    try {
      if (init.text) {
        return (await firstValueFrom(
          this.http.request(method, url, {
            body: init.body,
            params,
            headers,
            responseType: 'text',
          }),
        )) as T;
      }
      return (await firstValueFrom(
        this.http.request<T>(method, url, { body: init.body, params, headers }),
      )) as T;
    } catch (e) {
      const err = ApiError.from(e);
      if (
        err.status === 401 &&
        path !== '/auth/login' &&
        path !== '/auth/signup' &&
        path !== '/auth/logout' &&
        path !== '/config'
      ) {
        this.sessionExpired.next();
      } else if (err.status === 403 && !init.quiet)
        this.notifier.error("You don't have permission");
      throw err;
    }
  }

  private get = <T>(path: string, params?: Params, o?: RequestOptions) =>
    this.request<T>('GET', path, { params, quiet: o?.quiet });
  private post = <T>(path: string, body?: unknown, o?: RequestOptions) =>
    this.request<T>('POST', path, { body: body ?? {}, quiet: o?.quiet });
  /** Multipart upload. The browser sets the boundary; the interceptor adds the CSRF header. */
  private postForm = <T>(path: string, file: File) => {
    const body = new FormData();
    body.append('file', file, file.name);
    return this.request<T>('POST', path, { body });
  };
  private patch = <T>(path: string, body: unknown, o?: RequestOptions) =>
    this.request<T>('PATCH', path, { body, quiet: o?.quiet });
  private put = <T>(path: string, body?: unknown, o?: RequestOptions) =>
    this.request<T>('PUT', path, { body: body ?? {}, quiet: o?.quiet });
  private del = <T = void>(path: string, o?: RequestOptions & { body?: unknown }) =>
    this.request<T>('DELETE', path, { quiet: o?.quiet, body: o?.body });

  private w(slug: string): string {
    return `/w/${encodeURIComponent(slug)}`;
  }

  // ───────────────────────── health & auth ─────────────────────────

  health = () => this.get<{ ok: boolean }>('/health');
  /** Public settings available before sign-in, including tokens for configured Shared View pages. */
  publicConfig = () =>
    this.get<{
      demoLogin: boolean;
      roadmapViewToken: string | null;
      changelogViewToken: string | null;
    }>('/config');

  readonly auth = {
    login: async (input: LoginInput): Promise<User> =>
      unwrap<User>(await this.post<unknown>('/auth/login', input), 'user'),
    signup: async (input: SignupInput): Promise<User> =>
      unwrap<User>(await this.post<unknown>('/auth/signup', input), 'user'),
    logout: () => this.post<void>('/auth/logout'),
    /** 401 when there is no session. */
    me: async (): Promise<MeResponse> => {
      const res = await this.get<MeResponse | User>('/auth/me');
      return 'user' in res ? res : { user: res };
    },
  };

  // ───────────────────────── workspaces ─────────────────────────

  readonly workspaces = {
    list: async (): Promise<Workspace[]> =>
      unwrap<Workspace[]>(await this.get<unknown>('/workspaces'), 'workspaces'),
    create: (input: CreateWorkspaceInput) => this.post<Workspace>('/workspaces', input),
    get: (slug: string) => this.get<Workspace>(this.w(slug)),
    update: (slug: string, input: UpdateWorkspaceInput) =>
      this.patch<Workspace>(this.w(slug), input),
    /** Customization. Roles are changed with `createRole`, `updateRole` and `deleteRole` (owner). */
    updateSettings: (slug: string, input: UpdateWorkspaceSettingsInput) =>
      this.patch<Workspace>(`${this.w(slug)}/settings`, input),
    createRole: (slug: string, input: RoleInput) =>
      this.post<Workspace>(`${this.w(slug)}/roles`, input),
    updateRole: (slug: string, roleId: ID, input: UpdateRoleInput) =>
      this.patch<Workspace>(`${this.w(slug)}/roles/${roleId}`, input),
    deleteRole: (slug: string, roleId: ID) =>
      this.del<Workspace>(`${this.w(slug)}/roles/${roleId}`),
    createLabel: (slug: string, input: CreateLabelInput) =>
      this.post<Workspace>(`${this.w(slug)}/labels`, input),
    updateLabel: (slug: string, id: ID, input: UpdateLabelInput) =>
      this.patch<Workspace>(`${this.w(slug)}/labels/${id}`, input),
    mergeLabel: (slug: string, id: ID, input: MergeLabelInput) =>
      this.post<Workspace>(`${this.w(slug)}/labels/${id}/merge`, input),
    deleteLabel: (slug: string, id: ID) => this.del<Workspace>(`${this.w(slug)}/labels/${id}`),
    createStatus: (slug: string, subject: string, input: CreateStatusInput) =>
      this.post<Workspace>(`${this.w(slug)}/statuses/${subject}`, input),
    updateStatus: (slug: string, subject: string, id: ID, input: UpdateStatusInput) =>
      this.patch<Workspace>(`${this.w(slug)}/statuses/${subject}/${id}`, input),
    deleteStatus: (slug: string, subject: string, id: ID) =>
      this.del<Workspace>(`${this.w(slug)}/statuses/${subject}/${id}`),
    /** Owner only. `confirm` must be the workspace's exact slug or name. */
    remove: (slug: string, confirm: string) => this.del(this.w(slug), { body: { confirm } }),
    /** `comments: 'index'` leaves the comments out (threads load on demand via `comments.page`). */
    snapshot: (slug: string, comments: SnapshotCommentsMode = 'full') =>
      this.get<WorkspaceSnapshot>(
        `${this.w(slug)}/snapshot`,
        comments === 'full' ? undefined : { comments },
      ),
  };

  readonly members = {
    list: (slug: string) => this.get<Membership[]>(`${this.w(slug)}/members`),
    add: (slug: string, input: AddMemberInput) =>
      this.post<Membership>(`${this.w(slug)}/members`, input),
    update: (slug: string, membershipId: ID, input: UpdateMemberInput) =>
      this.patch<Membership>(`${this.w(slug)}/members/${membershipId}`, input),
    remove: (slug: string, membershipId: ID) => this.del(`${this.w(slug)}/members/${membershipId}`),
    /** Primary owner only: the target becomes owner and primary owner. */
    transferOwnership: (slug: string, membershipId: ID) =>
      this.post<Workspace>(`${this.w(slug)}/transfer-ownership`, { membershipId }),
  };

  /** Invitations by email (admins). `create` and `resend` return the secret link once. */
  readonly invites = {
    list: (slug: string) => this.get<WorkspaceInvite[]>(`${this.w(slug)}/invites`),
    create: (slug: string, input: CreateInviteInput) =>
      this.post<InviteLink>(`${this.w(slug)}/invites`, input),
    resend: (slug: string, id: ID) => this.post<InviteLink>(`${this.w(slug)}/invites/${id}/resend`),
    revoke: (slug: string, id: ID) => this.del(`${this.w(slug)}/invites/${id}`),
  };

  /** The signed-in user's notifications in a workspace, and their settings (the same in every workspace). */
  readonly notifications = {
    list: (slug: string, opts: { limit?: number; unread?: boolean } = {}) =>
      this.get<NotificationList>(
        `${this.w(slug)}/notifications`,
        { ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.unread ? { unread: true } : {}) },
        { quiet: true },
      ),
    /** Without `ids`, marks everything in the workspace as read. */
    markRead: (slug: string, ids?: ID[]) =>
      this.post<{ unread: number }>(`${this.w(slug)}/notifications/read`, ids ? { ids } : {}, {
        quiet: true,
      }),
    settings: () =>
      this.get<{ settings: NotificationSettings; emailAvailable: boolean }>(
        '/me/notification-settings',
      ),
    updateSettings: (settings: Partial<Record<NotificationKind, Partial<NotificationChannels>>>) =>
      this.patch<{ settings: NotificationSettings; emailAvailable: boolean }>(
        '/me/notification-settings',
        { settings },
      ),
  };

  /** Web Push for the signed-in user's devices. `publicKey` is null when the server has no VAPID keys. */
  readonly push = {
    status: () =>
      this.get<{ enabled: boolean; publicKey: string | null }>('/me/push', undefined, {
        quiet: true,
      }),
    subscribe: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
      this.request<{ enabled: boolean }>('PUT', '/me/push/subscription', { body: subscription }),
    unsubscribe: (endpoint: string) =>
      this.request<void>('DELETE', '/me/push/subscription', { body: { endpoint } }),
  };

  /** The signed-in user's favorites in a workspace (private to them). `remove` is idempotent. */
  readonly favorites = {
    list: (slug: string) =>
      this.get<Favorite[]>(`${this.w(slug)}/favorites`, undefined, { quiet: true }),
    add: (slug: string, type: FavoriteType, subjectId: ID) =>
      this.post<Favorite>(`${this.w(slug)}/favorites`, { type, subjectId }),
    remove: (slug: string, type: FavoriteType, subjectId: ID) =>
      this.del(`${this.w(slug)}/favorites/${type}/${encodeURIComponent(subjectId)}`),
  };

  /** The page behind an invitation link: `preview` is public, `accept` needs a signed-in user. */
  readonly inviteLinks = {
    preview: (token: string) =>
      this.get<InvitePreview>(`/invites/${encodeURIComponent(token)}`, undefined, { quiet: true }),
    accept: (token: string) =>
      this.post<{ workspace: { slug: string; name: string }; role: Role }>(
        `/invites/${encodeURIComponent(token)}/accept`,
        undefined,
        { quiet: true },
      ),
  };

  readonly agents = {
    list: (slug: string) => this.get<Agent[]>(`${this.w(slug)}/agents`),
    create: (slug: string, input: CreateAgentInput) =>
      this.post<Agent>(`${this.w(slug)}/agents`, input),
    update: (slug: string, id: ID, input: UpdateAgentInput) =>
      this.patch<Agent>(`${this.w(slug)}/agents/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/agents/${id}`),
  };

  readonly tokens = {
    list: (slug: string) => this.get<ApiToken[]>(`${this.w(slug)}/tokens`),
    /** The secret is returned once. */
    create: async (slug: string, input: CreateTokenInput): Promise<CreatedToken> => {
      const res = await this.post<Record<string, unknown>>(`${this.w(slug)}/tokens`, input);
      // Accept `{token, secret}` or a flat ApiToken with a `secret` field.
      if (res['token'] && typeof res['token'] === 'object') return res as unknown as CreatedToken;
      const { secret, ...token } = res;
      return { token: token as unknown as ApiToken, secret: String(secret ?? '') };
    },
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/tokens/${id}`),
  };

  // ───────────────────────── domain ─────────────────────────

  readonly projects = {
    list: (slug: string) => this.get<Project[]>(`${this.w(slug)}/projects`),
    get: (slug: string, id: ID) => this.get<Project>(`${this.w(slug)}/projects/${id}`),
    create: (slug: string, input: CreateProjectInput) =>
      this.post<Project>(`${this.w(slug)}/projects`, input),
    update: (slug: string, id: ID, input: UpdateProjectInput) =>
      this.patch<Project>(`${this.w(slug)}/projects/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/projects/${id}`),
    /** AI suggestion; the `kind` of the result matches the requested one. */
    ai: (slug: string, projectId: ID, kind: ProjectAiKind) =>
      this.post<ProjectAiResult>(`${this.w(slug)}/projects/${projectId}/ai/${kind}`),
  };

  readonly issues = {
    list: (slug: string) => this.get<Issue[]>(`${this.w(slug)}/tasks`),
    get: (slug: string, idOrKey: string) =>
      this.get<Issue>(`${this.w(slug)}/tasks/${encodeURIComponent(idOrKey)}`),
    create: (slug: string, input: CreateIssueInput) =>
      this.post<Issue>(`${this.w(slug)}/tasks`, input),
    update: (slug: string, id: ID, input: UpdateIssueInput) =>
      this.patch<Issue>(`${this.w(slug)}/tasks/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/tasks/${id}`),
    /** One patch for many issues, all or nothing. */
    bulkUpdate: (slug: string, ids: ID[], patch: BulkIssuePatch) =>
      this.post<Issue[]>(`${this.w(slug)}/tasks/bulk`, { ids, patch }),
    bulkRemove: (slug: string, ids: ID[]) =>
      this.post<{ deleted: ID[] }>(`${this.w(slug)}/tasks/bulk-delete`, { ids }),
    /** Link to a GitHub / Linear issue by URL; the external status is a read-only mirror. */
    externalRef: {
      link: (slug: string, idOrKey: string, url: string) =>
        this.post<Issue>(`${this.w(slug)}/tasks/${encodeURIComponent(idOrKey)}/external-ref`, {
          url,
        }),
      refresh: (slug: string, idOrKey: string) =>
        this.post<Issue>(
          `${this.w(slug)}/tasks/${encodeURIComponent(idOrKey)}/external-ref/refresh`,
        ),
      unlink: (slug: string, idOrKey: string) =>
        this.del<Issue>(`${this.w(slug)}/tasks/${encodeURIComponent(idOrKey)}/external-ref`),
    },
  };

  readonly milestones = {
    list: (slug: string, projectId?: ID) =>
      this.get<Milestone[]>(`${this.w(slug)}/milestones`, { projectId }),
    create: (slug: string, input: CreateMilestoneInput) =>
      this.post<Milestone>(`${this.w(slug)}/milestones`, input),
    update: (slug: string, id: ID, input: UpdateMilestoneInput) =>
      this.patch<Milestone>(`${this.w(slug)}/milestones/${id}`, input),
    /** Re-numbers sortOrder 0..n-1 following `ids`; returns the ordered milestones of the project. */
    reorder: (slug: string, projectId: ID, ids: ID[]) =>
      this.post<Milestone[]>(`${this.w(slug)}/milestones/reorder`, { projectId, ids }),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/milestones/${id}`),
  };

  readonly artifacts = {
    list: (slug: string) => this.get<Artifact[]>(`${this.w(slug)}/artifacts`),
  };

  readonly uploads = {
    /** A file to insert into a description or comment. Not visible to anyone else until that text is saved. */
    stage: (slug: string, file: File) =>
      this.postForm<{
        id: string;
        filename: string;
        contentType: string;
        byteSize: number;
        kind: 'image' | 'file';
        url: string;
        markdown: string;
      }>(`${this.w(slug)}/uploads`, file),
    /** Attach the file as an image or file artifact. The URL form is unchanged. */
    attach: (slug: string, target: { type: 'issue'; id: string }, file: File) =>
      this.postForm<Artifact>(
        `${this.w(slug)}/tasks/${encodeURIComponent(target.id)}/artifacts/upload`,
        file,
      ),
    discard: (slug: string, id: string, o?: RequestOptions) =>
      this.del(`${this.w(slug)}/uploads/${encodeURIComponent(id)}`, o),
  };

  readonly comments = {
    /** One page of the comments of a subject, newest first; pass `nextCursor` back as `cursor` for older ones. */
    page: (
      slug: string,
      subject: { type: string; id: ID },
      page: { cursor?: string; limit?: number } = {},
    ) =>
      this.get<CommentPage>(`${this.w(slug)}/comments/page`, {
        subjectType: subject.type,
        subjectId: subject.id,
        cursor: page.cursor,
        limit: page.limit,
      }),
    list: (slug: string, subject?: { type: string; id: ID }) =>
      this.get<Comment[]>(`${this.w(slug)}/comments`, {
        subjectType: subject?.type,
        subjectId: subject?.id,
      }),
    create: (slug: string, input: CreateCommentInput) =>
      this.post<Comment>(`${this.w(slug)}/comments`, input),
    update: (slug: string, id: ID, body: string) =>
      this.patch<Comment>(`${this.w(slug)}/comments/${id}`, { body }),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/comments/${id}`),
  };

  readonly events = {
    list: (slug: string, query: EventsQuery = {}) =>
      this.get<DomainEvent[]>(`${this.w(slug)}/events`, { ...query }),
  };

  readonly attention = {
    list: (slug: string, query: AttentionQuery = {}) =>
      this.get<AttentionItem[]>(`${this.w(slug)}/attention`, { ...query }),
    /** `id` is the attention item id, e.g. `review_requested:art_1` (URL-encoded here). */
    dismiss: (slug: string, id: string) =>
      this.post<void>(`${this.w(slug)}/attention/${encodeURIComponent(id)}/dismiss`),
    snooze: (slug: string, id: string, until: string) =>
      this.post<void>(`${this.w(slug)}/attention/${encodeURIComponent(id)}/snooze`, { until }),
    /** Undo a dismiss / snooze (drops the per-user state). */
    restore: (slug: string, id: string) =>
      this.post<AttentionItem>(`${this.w(slug)}/attention/${encodeURIComponent(id)}/restore`),
  };

  readonly views = {
    list: (slug: string) => this.get<SavedView[]>(`${this.w(slug)}/views`),
    create: (slug: string, input: CreateViewInput) =>
      this.post<SavedView>(`${this.w(slug)}/views`, input),
    update: (slug: string, id: ID, input: UpdateViewInput) =>
      this.patch<SavedView>(`${this.w(slug)}/views/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/views/${id}`),
    /** Invite existing workspace members by email. */
    invite: (slug: string, id: ID, input: InviteViewInput) =>
      this.post<SavedView>(`${this.w(slug)}/views/${id}/invite`, input),
    /** New public link; the old one stops working. */
    rotateLink: (slug: string, id: ID) =>
      this.post<SavedView>(`${this.w(slug)}/views/${id}/rotate-link`),
  };

  /** Anonymous, read-only: the fixed result of a view shared by link. */
  readonly publicViews = {
    get: (token: string) =>
      this.get<PublicView>(`/public/views/${encodeURIComponent(token)}`, undefined, {
        quiet: true,
      }),
  };

  search = (slug: string, q: string) => this.get<SearchResults>(`${this.w(slug)}/search`, { q });

  readonly integrations = {
    /** Admin only. Includes webhookUrl and lastWebhookAt. */
    list: (slug: string, o?: RequestOptions) =>
      this.get<IntegrationDetail[]>(`${this.w(slug)}/integrations`, undefined, o),
    /** Returns the connection and, for GitHub/GitLab, the one-time webhook setup (secret shown once). */
    create: (slug: string, input: CreateIntegrationInput) =>
      this.post<IntegrationWithWebhook>(`${this.w(slug)}/integrations`, input),
    /** Re-validates the token against the provider (refreshes account / status). */
    update: (slug: string, id: ID, input: UpdateIntegrationInput) =>
      this.patch<IntegrationDetail>(`${this.w(slug)}/integrations/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/integrations/${id}`),
    /** Withdraws the credential: status `revoked`, token wiped. A new token via `update` reconnects it. */
    revoke: (slug: string, id: ID) =>
      this.post<IntegrationDetail>(`${this.w(slug)}/integrations/${id}/revoke`),
    rotateWebhookSecret: (slug: string, id: ID) =>
      this.post<IntegrationWithWebhook>(`${this.w(slug)}/integrations/${id}/rotate-webhook-secret`),
  };

  /** The signed-in person's own connections (same in every workspace); only they can see them. */
  readonly connections = {
    list: (o?: RequestOptions) => this.get<IntegrationDetail[]>('/me/connections', undefined, o),
    create: (input: CreateIntegrationInput) =>
      this.post<IntegrationWithWebhook>('/me/connections', input),
    update: (id: ID, input: UpdateIntegrationInput) =>
      this.patch<IntegrationDetail>(`/me/connections/${id}`, input),
    revoke: (id: ID) => this.post<IntegrationDetail>(`/me/connections/${id}/revoke`),
    remove: (id: ID) => this.del(`/me/connections/${id}`),
    rotateWebhookSecret: (id: ID) =>
      this.post<IntegrationWithWebhook>(`/me/connections/${id}/rotate-webhook-secret`),
  };

  /** Custom integrations: signed JSON POSTs to your URL for domain events. Needs the manageIntegrations capability. */
  readonly outgoingWebhooks = {
    list: (slug: string, o?: RequestOptions) =>
      this.get<OutgoingWebhook[]>(`${this.w(slug)}/outgoing-webhooks`, undefined, o),
    /** The signing secret is returned once. */
    create: (slug: string, input: CreateWebhookInput) =>
      this.post<WebhookWithSecret>(`${this.w(slug)}/outgoing-webhooks`, input),
    update: (slug: string, id: ID, input: UpdateWebhookInput) =>
      this.patch<OutgoingWebhook>(`${this.w(slug)}/outgoing-webhooks/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/outgoing-webhooks/${id}`),
    rotateSecret: (slug: string, id: ID) =>
      this.post<WebhookWithSecret>(`${this.w(slug)}/outgoing-webhooks/${id}/rotate-secret`),
    /** Sends a ping now; resolves the delivery result (a failed delivery is still a 200). */
    test: (slug: string, id: ID) =>
      this.post<WebhookDeliveryLog>(`${this.w(slug)}/outgoing-webhooks/${id}/test`),
    deliveries: (slug: string, id: ID, limit = 20) =>
      this.get<WebhookDeliveryLog[]>(`${this.w(slug)}/outgoing-webhooks/${id}/deliveries`, {
        limit,
      }),
  };

  /** Import from GitHub Issues and Linear. Needs the manageIntegrations capability; tokens never come back. */
  readonly imports = {
    credentials: {
      list: (slug: string, o?: RequestOptions) =>
        this.get<ImportCredential[]>(`${this.w(slug)}/imports/credentials`, undefined, o),
      create: (slug: string, input: CreateImportCredentialInput) =>
        this.post<ImportCredential>(`${this.w(slug)}/imports/credentials`, input),
      remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/imports/credentials/${id}`),
    },
    /** Reads the source and suggests a mapping; writes nothing. */
    preview: (slug: string, input: ImportTargetInput) =>
      this.post<ImportPreview>(`${this.w(slug)}/imports/preview`, input),
    start: (slug: string, input: StartImportInput) =>
      this.post<ImportJob>(`${this.w(slug)}/imports`, input),
    list: (slug: string, o?: RequestOptions) =>
      this.get<ImportJob[]>(`${this.w(slug)}/imports`, undefined, o),
    get: (slug: string, id: ID, o?: RequestOptions) =>
      this.get<ImportJob>(`${this.w(slug)}/imports/${id}`, undefined, o),
    cancel: (slug: string, id: ID) => this.post<ImportJob>(`${this.w(slug)}/imports/${id}/cancel`),
    retry: (slug: string, id: ID) => this.post<ImportJob>(`${this.w(slug)}/imports/${id}/retry`),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/imports/${id}`),
  };

  /** The signed-in person's timer. */
  readonly timeEntries = {
    list: (slug: string, o?: RequestOptions) =>
      this.get<TimeEntry[]>(`${this.w(slug)}/time-entries`, undefined, o),
    start: (slug: string, input: TimeEntryTarget = {}, o?: RequestOptions) =>
      this.post<TimeEntry>(`${this.w(slug)}/time-entries/start`, input, o),
    stop: (slug: string, o?: RequestOptions) =>
      this.post<TimeEntry>(`${this.w(slug)}/time-entries/stop`, {}, o),
    add: (slug: string, input: ManualTimeEntryInput, o?: RequestOptions) =>
      this.post<TimeEntry>(`${this.w(slug)}/time-entries`, input, o),
    remove: (slug: string, id: ID, o?: RequestOptions) =>
      this.del(`${this.w(slug)}/time-entries/${id}`, o),
  };

  /** URL of the workspace SSE stream (for EventSource). */
  eventStreamUrl(slug: string): string {
    return `${this.baseUrl}${this.w(slug)}/events/stream`;
  }
}
