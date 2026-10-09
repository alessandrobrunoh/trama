// ApiClient — typed wrapper over the Nabla REST API (PLAN.md §4). Promise-based.
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
  Decision,
  Dependency,
  DomainEvent,
  Favorite,
  FavoriteType,
  ID,
  InputRequest,
  NotificationKind,
  NotificationChannels,
  NotificationList,
  NotificationSettings,
  InviteLink,
  InvitePreview,
  Customer,
  CustomerRequest,
  Issue,
  Membership,
  Milestone,
  OutgoingWebhook,
  Project,
  ProjectAiKind,
  ProjectAiResult,
  ProjectContext,
  ProjectUpdate,
  Repository,
  Role,
  SavedView,
  Team,
  User,
  WebhookDeliveryLog,
  Workspace,
  WorkspaceInvite,
  WorkspaceSnapshot,
  Workstream,
} from '../contracts/domain';
import { Notifier } from '../notify/notifier';
import { ApiError } from './api-error';
import type {
  AddMemberInput,
  AttentionQuery,
  CreateAgentInput,
  CreateArtifactInput,
  CreateCommentInput,
  CreateDecisionInput,
  CreateDependencyInput,
  CreateInputRequestInput,
  CreateInviteInput,
  CreateMilestoneInput,
  UpdateMilestoneInput,
  UpdateInputRequestInput,
  CreateCustomerInput,
  CreateIssueInput,
  LinkCustomerInput,
  CreateIntegrationInput,
  IntegrationDetail,
  IntegrationWithWebhook,
  LinkRepositoryInput,
  RemoteRepositoryPage,
  UpdateIntegrationInput,
  CreateOwnedArtifactInput,
  CreateProjectInput,
  CreateProjectUpdateInput,
  CreateRepositoryInput,
  CreateTeamInput,
  CreateTokenInput,
  CreatedToken,
  CreateViewInput,
  CreateWorkspaceInput,
  CreateWorkstreamInput,
  CriterionInput,
  CriterionPatch,
  EventsQuery,
  GraphResponse,
  LoginInput,
  MeResponse,
  SearchResults,
  SignupInput,
  LinkIssueInput,
  UpdateAgentInput,
  UpdateArtifactInput,
  UpdateDecisionInput,
  UpdateCustomerInput,
  UpdateIssueInput,
  UpdateMemberInput,
  UpdateProjectInput,
  UpdateProjectUpdateInput,
  UpdateRepositoryInput,
  UpdateTeamInput,
  UpdateViewInput,
  UpdateWorkspaceInput,
  CreateLabelInput,
  CreateWebhookInput,
  UpdateLabelInput,
  UpdateWebhookInput,
  UpdateWorkspaceSettingsInput,
  WebhookWithSecret,
  UpdateWorkstreamInput,
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
    init: { body?: unknown; params?: Params; text?: boolean; accept?: string; quiet?: boolean } = {},
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
          this.http.request(method, url, { body: init.body, params, headers, responseType: 'text' }),
        )) as T;
      }
      return (await firstValueFrom(
        this.http.request<T>(method, url, { body: init.body, params, headers }),
      )) as T;
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status === 401 && path !== '/auth/login' && path !== '/auth/signup' && path !== '/auth/logout') {
        this.sessionExpired.next();
      }
      else if (err.status === 403 && !init.quiet) this.notifier.error("You don't have permission");
      throw err;
    }
  }

  private get = <T>(path: string, params?: Params, o?: RequestOptions) =>
    this.request<T>('GET', path, { params, quiet: o?.quiet });
  private post = <T>(path: string, body?: unknown, o?: RequestOptions) =>
    this.request<T>('POST', path, { body: body ?? {}, quiet: o?.quiet });
  private patch = <T>(path: string, body: unknown, o?: RequestOptions) =>
    this.request<T>('PATCH', path, { body, quiet: o?.quiet });
  private del = <T = void>(path: string, o?: RequestOptions) =>
    this.request<T>('DELETE', path, { quiet: o?.quiet });

  private w(slug: string): string {
    return `/w/${encodeURIComponent(slug)}`;
  }

  // ───────────────────────── health & auth ─────────────────────────

  health = () => this.get<{ ok: boolean }>('/health');

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
    update: (slug: string, input: UpdateWorkspaceInput) => this.patch<Workspace>(this.w(slug), input),
    /** Customization + permission policy. Admin; changing `permissions` needs an owner. */
    updateSettings: (slug: string, input: UpdateWorkspaceSettingsInput) =>
      this.patch<Workspace>(`${this.w(slug)}/settings`, input),
    createLabel: (slug: string, input: CreateLabelInput) => this.post<Workspace>(`${this.w(slug)}/labels`, input),
    updateLabel: (slug: string, id: ID, input: UpdateLabelInput) => this.patch<Workspace>(`${this.w(slug)}/labels/${id}`, input),
    deleteLabel: (slug: string, id: ID) => this.del<Workspace>(`${this.w(slug)}/labels/${id}`),
    /** Owner only. */
    remove: (slug: string) => this.del(this.w(slug)),
    snapshot: (slug: string) => this.get<WorkspaceSnapshot>(`${this.w(slug)}/snapshot`),
  };

  readonly members = {
    list: (slug: string) => this.get<Membership[]>(`${this.w(slug)}/members`),
    add: (slug: string, input: AddMemberInput) =>
      this.post<Membership>(`${this.w(slug)}/members`, input),
    update: (slug: string, membershipId: ID, input: UpdateMemberInput) =>
      this.patch<Membership>(`${this.w(slug)}/members/${membershipId}`, input),
    remove: (slug: string, membershipId: ID) => this.del(`${this.w(slug)}/members/${membershipId}`),
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
      this.post<{ unread: number }>(`${this.w(slug)}/notifications/read`, ids ? { ids } : {}, { quiet: true }),
    settings: () =>
      this.get<{ settings: NotificationSettings; emailAvailable: boolean }>('/me/notification-settings'),
    updateSettings: (settings: Partial<Record<NotificationKind, Partial<NotificationChannels>>>) =>
      this.patch<{ settings: NotificationSettings; emailAvailable: boolean }>('/me/notification-settings', { settings }),
  };

  /** Web Push for the signed-in user's devices. `publicKey` is null when the server has no VAPID keys. */
  readonly push = {
    status: () =>
      this.get<{ enabled: boolean; publicKey: string | null }>('/me/push', undefined, { quiet: true }),
    subscribe: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
      this.request<{ enabled: boolean }>('PUT', '/me/push/subscription', { body: subscription }),
    unsubscribe: (endpoint: string) =>
      this.request<void>('DELETE', '/me/push/subscription', { body: { endpoint } }),
  };

  /** The signed-in user's favorites in a workspace (private to them). `remove` is idempotent. */
  readonly favorites = {
    list: (slug: string) => this.get<Favorite[]>(`${this.w(slug)}/favorites`, undefined, { quiet: true }),
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

  readonly teams = {
    list: (slug: string) => this.get<Team[]>(`${this.w(slug)}/teams`),
    get: (slug: string, id: ID) => this.get<Team>(`${this.w(slug)}/teams/${id}`),
    create: (slug: string, input: CreateTeamInput) => this.post<Team>(`${this.w(slug)}/teams`, input),
    update: (slug: string, id: ID, input: UpdateTeamInput) =>
      this.patch<Team>(`${this.w(slug)}/teams/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/teams/${id}`),
  };

  readonly customers = {
    list: (slug: string) => this.get<Customer[]>(`${this.w(slug)}/customers`, { archived: 'all' }),
    get: (slug: string, id: ID) => this.get<Customer>(`${this.w(slug)}/customers/${id}`),
    create: (slug: string, input: CreateCustomerInput) => this.post<Customer>(`${this.w(slug)}/customers`, input),
    update: (slug: string, id: ID, input: UpdateCustomerInput) =>
      this.patch<Customer>(`${this.w(slug)}/customers/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/customers/${id}`),
    requests: (slug: string, id: ID) =>
      this.get<CustomerRequest[]>(`${this.w(slug)}/customers/${id}/requests`),
    link: (slug: string, id: ID, input: LinkCustomerInput) =>
      this.post<CustomerRequest>(`${this.w(slug)}/customers/${id}/requests`, input),
    unlink: (slug: string, id: ID, requestId: ID) =>
      this.post<void>(`${this.w(slug)}/customers/${id}/requests/${requestId}/unlink`),
  };

  readonly projects = {
    list: (slug: string) => this.get<Project[]>(`${this.w(slug)}/projects`),
    get: (slug: string, id: ID) => this.get<Project>(`${this.w(slug)}/projects/${id}`),
    create: (slug: string, input: CreateProjectInput) => this.post<Project>(`${this.w(slug)}/projects`, input),
    update: (slug: string, id: ID, input: UpdateProjectInput) => this.patch<Project>(`${this.w(slug)}/projects/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/projects/${id}`),
    /** Status posts, newest first. */
    updates: {
      list: (slug: string, projectId: ID) => this.get<ProjectUpdate[]>(`${this.w(slug)}/projects/${projectId}/updates`),
      get: (slug: string, projectId: ID, id: ID) =>
        this.get<ProjectUpdate>(`${this.w(slug)}/projects/${projectId}/updates/${id}`),
      create: (slug: string, projectId: ID, input: CreateProjectUpdateInput) =>
        this.post<ProjectUpdate>(`${this.w(slug)}/projects/${projectId}/updates`, input),
      update: (slug: string, projectId: ID, id: ID, input: UpdateProjectUpdateInput) =>
        this.patch<ProjectUpdate>(`${this.w(slug)}/projects/${projectId}/updates/${id}`, input),
      remove: (slug: string, projectId: ID, id: ID) =>
        this.del(`${this.w(slug)}/projects/${projectId}/updates/${id}`),
    },
    /** The whole tree under a project in one response (workstreams, issues, artifacts with paths, updates...). */
    context: (slug: string, projectId: ID) =>
      this.get<ProjectContext>(`${this.w(slug)}/projects/${projectId}/context`),
    /** The same context rendered as markdown (for agents / copy). */
    contextMarkdown: (slug: string, projectId: ID) =>
      this.request<string>('GET', `${this.w(slug)}/projects/${projectId}/context.md`, {
        text: true,
        accept: 'text/markdown',
      }),
    /** AI suggestion; the `kind` of the result matches the requested one. */
    ai: (slug: string, projectId: ID, kind: ProjectAiKind) =>
      this.post<ProjectAiResult>(`${this.w(slug)}/projects/${projectId}/ai/${kind}`),
    /** Artifacts attached to the project itself (use `context` for the whole tree). */
    artifacts: {
      list: (slug: string, projectId: ID) =>
        this.get<Artifact[]>(`${this.w(slug)}/projects/${projectId}/artifacts`),
      create: (slug: string, projectId: ID, input: CreateOwnedArtifactInput) =>
        this.post<Artifact>(`${this.w(slug)}/projects/${projectId}/artifacts`, input),
    },
  };

  readonly repositories = {
    list: (slug: string) => this.get<Repository[]>(`${this.w(slug)}/repositories`),
    get: (slug: string, id: ID) => this.get<Repository>(`${this.w(slug)}/repositories/${id}`),
    create: (slug: string, input: CreateRepositoryInput) =>
      this.post<Repository>(`${this.w(slug)}/repositories`, input),
    update: (slug: string, id: ID, input: UpdateRepositoryInput) =>
      this.patch<Repository>(`${this.w(slug)}/repositories/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/repositories/${id}`),
  };

  readonly workstreams = {
    list: (slug: string) => this.get<Workstream[]>(`${this.w(slug)}/workstreams`),
    /** `idOrKey`: id or key like AUTH-42. */
    get: (slug: string, idOrKey: string) =>
      this.get<Workstream>(`${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}`),
    create: (slug: string, input: CreateWorkstreamInput) =>
      this.post<Workstream>(`${this.w(slug)}/workstreams`, input),
    update: (slug: string, idOrKey: string, input: UpdateWorkstreamInput) =>
      this.patch<Workstream>(`${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}`, input),
    remove: (slug: string, idOrKey: string) =>
      this.del(`${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}`),
    /** Criterion calls return the updated Workstream. */
    addCriterion: (slug: string, idOrKey: string, input: CriterionInput) =>
      this.post<unknown>(`${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}/criteria`, input),
    updateCriterion: (slug: string, idOrKey: string, criterionId: ID, input: CriterionPatch) =>
      this.patch<unknown>(
        `${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}/criteria/${criterionId}`,
        input,
      ),
    removeCriterion: (slug: string, idOrKey: string, criterionId: ID) =>
      this.del<unknown>(
        `${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}/criteria/${criterionId}`,
      ),
    /** Agent context as markdown text. */
    contextMarkdown: (slug: string, idOrKey: string) =>
      this.request<string>(
        'GET',
        `${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}/context`,
        { text: true, accept: 'text/markdown' },
      ),
    /** Agent context as JSON (Accept: application/json). */
    contextJson: (slug: string, idOrKey: string) =>
      this.request<Record<string, unknown>>(
        'GET',
        `${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}/context`,
        { accept: 'application/json' },
      ),
    graph: (slug: string, idOrKey: string) =>
      this.get<GraphResponse>(
        `${this.w(slug)}/workstreams/${encodeURIComponent(idOrKey)}/graph`,
      ),
  };

  readonly inputRequests = {
    list: (slug: string) => this.get<InputRequest[]>(`${this.w(slug)}/input-requests`),
    create: (slug: string, input: CreateInputRequestInput) =>
      this.post<InputRequest>(`${this.w(slug)}/input-requests`, input),
    answer: (slug: string, id: ID, answer: string) =>
      this.post<InputRequest>(`${this.w(slug)}/input-requests/${id}/answer`, { answer }),
    dismiss: (slug: string, id: ID) =>
      this.post<InputRequest>(`${this.w(slug)}/input-requests/${id}/dismiss`),
    /** Open requests only (`409` otherwise). */
    update: (slug: string, id: ID, input: UpdateInputRequestInput) =>
      this.patch<InputRequest>(`${this.w(slug)}/input-requests/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/input-requests/${id}`),
  };

  readonly issues = {
    list: (slug: string) => this.get<Issue[]>(`${this.w(slug)}/issues`),
    get: (slug: string, idOrKey: string) =>
      this.get<Issue>(`${this.w(slug)}/issues/${encodeURIComponent(idOrKey)}`),
    create: (slug: string, input: CreateIssueInput) =>
      this.post<Issue>(`${this.w(slug)}/issues`, input),
    update: (slug: string, id: ID, input: UpdateIssueInput) =>
      this.patch<Issue>(`${this.w(slug)}/issues/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/issues/${id}`),
    /** Attach workstreams (and optionally create one). `id` may be an id or key. */
    link: (slug: string, id: ID, input: LinkIssueInput) =>
      this.post<Issue>(`${this.w(slug)}/issues/${id}/link`, input),
    artifacts: {
      list: (slug: string, idOrKey: string) =>
        this.get<Artifact[]>(`${this.w(slug)}/issues/${encodeURIComponent(idOrKey)}/artifacts`),
      create: (slug: string, idOrKey: string, input: CreateOwnedArtifactInput) =>
        this.post<Artifact>(`${this.w(slug)}/issues/${encodeURIComponent(idOrKey)}/artifacts`, input),
    },
  };

  readonly milestones = {
    list: (slug: string, projectId?: ID) => this.get<Milestone[]>(`${this.w(slug)}/milestones`, { projectId }),
    create: (slug: string, input: CreateMilestoneInput) => this.post<Milestone>(`${this.w(slug)}/milestones`, input),
    update: (slug: string, id: ID, input: UpdateMilestoneInput) =>
      this.patch<Milestone>(`${this.w(slug)}/milestones/${id}`, input),
    /** Re-numbers sortOrder 0..n-1 following `ids`; returns the ordered milestones of the project. */
    reorder: (slug: string, projectId: ID, ids: ID[]) =>
      this.post<Milestone[]>(`${this.w(slug)}/milestones/reorder`, { projectId, ids }),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/milestones/${id}`),
  };

  readonly artifacts = {
    list: (slug: string) => this.get<Artifact[]>(`${this.w(slug)}/artifacts`),
    create: (slug: string, input: CreateArtifactInput) =>
      this.post<Artifact>(`${this.w(slug)}/artifacts`, input),
    update: (slug: string, id: ID, input: UpdateArtifactInput) =>
      this.patch<Artifact>(`${this.w(slug)}/artifacts/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/artifacts/${id}`),
  };

  readonly decisions = {
    list: (slug: string) => this.get<Decision[]>(`${this.w(slug)}/decisions`),
    get: (slug: string, idOrKey: string) =>
      this.get<Decision>(`${this.w(slug)}/decisions/${encodeURIComponent(idOrKey)}`),
    create: (slug: string, input: CreateDecisionInput) =>
      this.post<Decision>(`${this.w(slug)}/decisions`, input),
    update: (slug: string, id: ID, input: UpdateDecisionInput) =>
      this.patch<Decision>(`${this.w(slug)}/decisions/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/decisions/${id}`),
    accept: (slug: string, id: ID) => this.post<Decision>(`${this.w(slug)}/decisions/${id}/accept`),
    reject: (slug: string, id: ID) => this.post<Decision>(`${this.w(slug)}/decisions/${id}/reject`),
    supersede: (slug: string, id: ID, byId: ID) =>
      this.post<Decision>(`${this.w(slug)}/decisions/${id}/supersede`, { byId }),
  };

  readonly dependencies = {
    list: (slug: string) => this.get<Dependency[]>(`${this.w(slug)}/dependencies`),
    create: (slug: string, input: CreateDependencyInput) =>
      this.post<Dependency>(`${this.w(slug)}/dependencies`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/dependencies/${id}`),
  };

  readonly comments = {
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
    /** `id` is the attention item id, e.g. `input_requested:ir_1` (URL-encoded here). */
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
  };

  graph = (slug: string) => this.get<GraphResponse>(`${this.w(slug)}/graph`);

  search = (slug: string, q: string) => this.get<SearchResults>(`${this.w(slug)}/search`, { q });

  readonly integrations = {
    /** Admin only. Includes webhookUrl, linked repository ids and lastWebhookAt. */
    list: (slug: string, o?: RequestOptions) => this.get<IntegrationDetail[]>(`${this.w(slug)}/integrations`, undefined, o),
    /** Returns the connection and, for GitHub/GitLab, the one-time webhook setup (secret shown once). */
    create: (slug: string, input: CreateIntegrationInput) =>
      this.post<IntegrationWithWebhook>(`${this.w(slug)}/integrations`, input),
    /** Re-validates the token against the provider (refreshes account / status). */
    update: (slug: string, id: ID, input: UpdateIntegrationInput) =>
      this.patch<IntegrationDetail>(`${this.w(slug)}/integrations/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/integrations/${id}`),
    rotateWebhookSecret: (slug: string, id: ID) =>
      this.post<IntegrationWithWebhook>(`${this.w(slug)}/integrations/${id}/rotate-webhook-secret`),
    remoteRepositories: (slug: string, id: ID, page = 1, perPage = 30) =>
      this.get<RemoteRepositoryPage>(`${this.w(slug)}/integrations/${id}/remote-repositories`, { page, perPage }),
    /** Creates (201) or adopts (200) the Repository and attaches it to the connection. */
    linkRepository: (slug: string, id: ID, input: LinkRepositoryInput) =>
      this.post<Repository>(`${this.w(slug)}/integrations/${id}/link-repository`, input),
    unlinkRepository: (slug: string, id: ID, repositoryId: ID) =>
      this.del(`${this.w(slug)}/integrations/${id}/repositories/${repositoryId}`),
  };

  /** Custom integrations: signed JSON POSTs to your URL for domain events. Needs the manageIntegrations capability. */
  readonly outgoingWebhooks = {
    list: (slug: string, o?: RequestOptions) => this.get<OutgoingWebhook[]>(`${this.w(slug)}/outgoing-webhooks`, undefined, o),
    /** The signing secret is returned once. */
    create: (slug: string, input: CreateWebhookInput) =>
      this.post<WebhookWithSecret>(`${this.w(slug)}/outgoing-webhooks`, input),
    update: (slug: string, id: ID, input: UpdateWebhookInput) =>
      this.patch<OutgoingWebhook>(`${this.w(slug)}/outgoing-webhooks/${id}`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/outgoing-webhooks/${id}`),
    rotateSecret: (slug: string, id: ID) =>
      this.post<WebhookWithSecret>(`${this.w(slug)}/outgoing-webhooks/${id}/rotate-secret`),
    /** Sends a ping now; resolves the delivery result (a failed delivery is still a 200). */
    test: (slug: string, id: ID) => this.post<WebhookDeliveryLog>(`${this.w(slug)}/outgoing-webhooks/${id}/test`),
    deliveries: (slug: string, id: ID, limit = 20) =>
      this.get<WebhookDeliveryLog[]>(`${this.w(slug)}/outgoing-webhooks/${id}/deliveries`, { limit }),
  };

  /** URL of the workspace SSE stream (for EventSource). */
  eventStreamUrl(slug: string): string {
    return `${this.baseUrl}${this.w(slug)}/events/stream`;
  }
}
