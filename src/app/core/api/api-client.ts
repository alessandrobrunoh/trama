// ApiClient — typed wrapper over the Nabla REST API (PLAN.md §4). Promise-based.
//
// - Base URL `/api` (API_BASE_URL); cookie session; `X-Client-Id` on writes (apiInterceptor).
// - Every call rejects with `ApiError`. Side effects of failures (done once, here):
//     401 (except on /auth/*)  -> `sessionExpired` fires; SessionStore clears the session and
//                                  redirects to /login?next=...
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
  ID,
  InputRequest,
  Issue,
  IntegrationConnection,
  Membership,
  Repository,
  SavedView,
  Team,
  User,
  Workspace,
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
  CreateIssueInput,
  CreateIntegrationInput,
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
  UpdateIssueInput,
  UpdateMemberInput,
  UpdateRepositoryInput,
  UpdateTeamInput,
  UpdateViewInput,
  UpdateWorkspaceInput,
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

  /** Emits when the server rejects the session (401 on a non-auth endpoint). */
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
      if (err.status === 401 && !path.startsWith('/auth/')) this.sessionExpired.next();
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
    list: (slug: string) => this.get<IntegrationConnection[]>(`${this.w(slug)}/integrations`),
    create: (slug: string, input: CreateIntegrationInput) =>
      this.post<IntegrationConnection>(`${this.w(slug)}/integrations`, input),
    remove: (slug: string, id: ID) => this.del(`${this.w(slug)}/integrations/${id}`),
    sync: (slug: string, id: ID) =>
      this.post<IntegrationConnection | void>(`${this.w(slug)}/integrations/${id}/sync`),
  };

  /** URL of the workspace SSE stream (for EventSource). */
  eventStreamUrl(slug: string): string {
    return `${this.baseUrl}${this.w(slug)}/events/stream`;
  }
}
