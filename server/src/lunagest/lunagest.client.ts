import { BadRequestException } from '@nestjs/common';
import { outboundUrlProblem } from '../common/safe-fetch.js';
import { HttpClient, type HttpResponse } from '../integrations/http-client.js';

export const LUNAGEST_DEFAULT_BASE_URL = 'https://panel.lunagest.com';
/** Public Supabase anon key. Sent as `apikey` and as the Bearer token on login. Not a user password. */
export const LUNAGEST_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc2OTUyMzE3LCJleHAiOjE5MzQ2MzIzMTd9.2W7ryk4ynSYN0QpifBP0pfAKxlfS1144-xq2U9yuVnY';

function panelHeaders(apiKey: string, bearer = apiKey): Record<string, string> {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    'x-client-info': 'supabase-js-web/2.103.3',
    'x-supabase-api-version': '2024-01-01',
  };
}

const BAD_BASE_URL = 'baseUrl must be an https origin';
const LOGIN_REJECTED = 'LunaGest rejected the login';
const PROJECTS_UNAVAILABLE = 'LunaGest did not return projects';
const TASK_REJECTED = 'LunaGest did not accept the task';
const TASKS_UNAVAILABLE = 'LunaGest did not return tasks';

export type LunaGestTaskWrite =
  | { ok: true; id: string }
  | { ok: false; error: string };

export interface LunaGestCredentials {
  username: string;
  password: string;
  apiKey: string;
}

export interface LunaGestRemoteProject {
  id: string;
  name: string;
  /** Null when the payload has no description, so a realign does not invent one. */
  description: string | null;
}

export interface LunaGestRemoteTask {
  id: string;
  title: string;
  description: string;
}

/** https origin only: no userinfo, path, query, or hash. Blank becomes the panel origin. */
export async function normalizeLunaGestBaseUrl(
  raw: string | undefined,
): Promise<string> {
  const value = raw?.trim() || LUNAGEST_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(BAD_BASE_URL);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new BadRequestException(BAD_BASE_URL);
  }
  const origin = url.origin;
  // Shape only. The request itself still goes through HttpClient's SSRF guard; don't DNS-lookup here.
  const problem = await outboundUrlProblem(origin, { resolve: false });
  if (problem) throw new BadRequestException(BAD_BASE_URL);
  return origin;
}

function accessToken(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const token = (json as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token))
    return null;
  return token;
}

function remoteProjects(json: unknown): LunaGestRemoteProject[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? Object.values(json).find(Array.isArray)
      : undefined;
  if (!Array.isArray(list)) throw new BadRequestException(PROJECTS_UNAVAILABLE);
  const out: LunaGestRemoteProject[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    const name = (row as { name?: unknown }).name;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof name !== 'string' ||
      name.length === 0
    )
      continue;
    const description = (row as { description?: unknown }).description;
    out.push({
      id,
      name,
      description: typeof description === 'string' ? description : null,
    });
  }
  return out;
}

function remoteTasks(json: unknown): LunaGestRemoteTask[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? Object.values(json).find(Array.isArray)
      : undefined;
  if (!Array.isArray(list)) throw new BadRequestException(TASKS_UNAVAILABLE);
  const out: LunaGestRemoteTask[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    const title = (row as { title?: unknown }).title;
    const description = (row as { description?: unknown }).description;
    if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string')
      continue;
    out.push({
      id,
      title,
      description: typeof description === 'string' ? description : '',
    });
  }
  return out;
}

function taskId(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const id = (json as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Login, project list, and task title/description writes. Errors never carry upstream bodies. */
export class LunaGestClient {
  constructor(private readonly http: HttpClient) {}

  async login(baseUrl: string, creds: LunaGestCredentials): Promise<string> {
    let res: HttpResponse;
    try {
      res = await this.http.request({
        method: 'POST',
        url: `${baseUrl}/auth/v1/token?grant_type=password`,
        headers: panelHeaders(creds.apiKey),
        body: {
          email: creds.username,
          password: creds.password,
          gotrue_meta_security: {},
        },
      });
    } catch {
      throw new BadRequestException(LOGIN_REJECTED);
    }
    const token = accessToken(res.json);
    if (res.status < 200 || res.status >= 300 || !token)
      throw new BadRequestException(LOGIN_REJECTED);
    return token;
  }

  /** GET projects. A 401 logs in once more and retries the GET once. */
  async listProjects(
    baseUrl: string,
    creds: LunaGestCredentials,
  ): Promise<LunaGestRemoteProject[]> {
    let token = await this.login(baseUrl, creds);
    let res = await this.readProjects(baseUrl, creds.apiKey, token);
    if (res.status === 401) {
      token = await this.login(baseUrl, creds);
      res = await this.readProjects(baseUrl, creds.apiKey, token);
    }
    if (res.status < 200 || res.status >= 300)
      throw new BadRequestException(PROJECTS_UNAVAILABLE);
    return remoteProjects(res.json);
  }

  private async readProjects(
    baseUrl: string,
    apiKey: string,
    token: string,
  ): Promise<HttpResponse> {
    try {
      return await this.http.request({
        method: 'GET',
        url: `${baseUrl}/functions/v1/pm?resource=projects`,
        headers: panelHeaders(apiKey, token),
      });
    } catch {
      throw new BadRequestException(PROJECTS_UNAVAILABLE);
    }
  }

  /** Tasks of one remote project. A 401 logs in once more and retries once. */
  async listTasks(
    baseUrl: string,
    creds: LunaGestCredentials,
    remoteProjectId: string,
  ): Promise<LunaGestRemoteTask[]> {
    const res = await this.authed(baseUrl, creds, (token) =>
      this.http.request({
        method: 'GET',
        url: `${baseUrl}/functions/v1/pm?resource=tasks&project_id=${encodeURIComponent(remoteProjectId)}`,
        headers: panelHeaders(creds.apiKey, token),
      }),
    );
    if (!res || res.status < 200 || res.status >= 300)
      throw new BadRequestException(res ? TASKS_UNAVAILABLE : LOGIN_REJECTED);
    return remoteTasks(res.json);
  }

  /** POST a task. Failure is a result, not an exception, so the Trama issue can stay. */
  async createTask(
    baseUrl: string,
    creds: LunaGestCredentials,
    task: { title: string; description: string; projectId: string },
  ): Promise<LunaGestTaskWrite> {
    return this.writeTask(baseUrl, creds, {
      method: 'POST',
      url: `${baseUrl}/functions/v1/pm?resource=tasks`,
      body: {
        title: task.title,
        description: task.description,
        project_id: task.projectId,
      },
    });
  }

  /** PUT title and description of a task that already has an id. */
  async updateTask(
    baseUrl: string,
    creds: LunaGestCredentials,
    task: { id: string; title: string; description: string },
  ): Promise<LunaGestTaskWrite> {
    return this.writeTask(baseUrl, creds, {
      method: 'PUT',
      url: `${baseUrl}/functions/v1/pm?resource=tasks&id=${encodeURIComponent(task.id)}`,
      body: { title: task.title, description: task.description },
      knownId: task.id,
    });
  }

  private async writeTask(
    baseUrl: string,
    creds: LunaGestCredentials,
    req: {
      method: 'POST' | 'PUT';
      url: string;
      body: Record<string, string>;
      knownId?: string;
    },
  ): Promise<LunaGestTaskWrite> {
    let res: HttpResponse | null;
    try {
      res = await this.authed(baseUrl, creds, (token) =>
        this.http.request({
          method: req.method,
          url: req.url,
          headers: panelHeaders(creds.apiKey, token),
          body: req.body,
        }),
      );
    } catch {
      return { ok: false, error: TASK_REJECTED };
    }
    if (!res) return { ok: false, error: LOGIN_REJECTED };
    const id = taskId(res.json) ?? req.knownId ?? null;
    if (res.status < 200 || res.status >= 300 || !id)
      return { ok: false, error: TASK_REJECTED };
    return { ok: true, id };
  }

  /** Login, run, and on 401 login once more. `null` means login failed. */
  private async authed(
    baseUrl: string,
    creds: LunaGestCredentials,
    run: (token: string) => Promise<HttpResponse>,
  ): Promise<HttpResponse | null> {
    let token: string;
    try {
      token = await this.login(baseUrl, creds);
    } catch {
      return null;
    }
    let res: HttpResponse;
    try {
      res = await run(token);
    } catch {
      throw new BadRequestException(TASKS_UNAVAILABLE);
    }
    if (res.status !== 401) return res;
    try {
      token = await this.login(baseUrl, creds);
    } catch {
      return null;
    }
    try {
      return await run(token);
    } catch {
      throw new BadRequestException(TASKS_UNAVAILABLE);
    }
  }
}
