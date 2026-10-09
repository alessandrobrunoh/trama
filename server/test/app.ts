import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return app;
}

type Server = Parameters<typeof request>[0];

let counter = 0;
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A logged-in browser-like client (cookie session + the CSRF header). */
export class Client {
  constructor(
    private readonly server: Server,
    private cookie = '',
  ) {}

  static async signup(server: Server, name = 'Test User'): Promise<{ client: Client; email: string; user: { id: string } }> {
    const email = `${uniq('u')}@test.dev`;
    const res = await request(server)
      .post('/api/auth/signup')
      .set('X-Requested-With', 'test')
      .send({ name, email, password: 'password123' })
      .expect(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    return { client: new Client(server, cookie), email, user: res.body.user };
  }

  /** Raw `Cookie` header this client sends. */
  get cookieHeader(): string {
    return this.cookie;
  }

  private with(r: request.Test): request.Test {
    return r.set('Cookie', this.cookie).set('X-Client-Id', 'test-client');
  }
  get = (url: string) => this.with(request(this.server).get(url));
  post = (url: string, body?: object) => this.with(request(this.server).post(url)).send(body);
  put = (url: string, body?: object) => this.with(request(this.server).put(url)).send(body);
  patch = (url: string, body?: object) => this.with(request(this.server).patch(url)).send(body);
  delete = (url: string, body?: object) => {
    const r = this.with(request(this.server).delete(url));
    return body ? r.send(body) : r;
  };
}

/** Bearer-token client (API tokens, agents). */
export class TokenClient {
  constructor(
    private readonly server: Server,
    private readonly token: string,
  ) {}
  private with(r: request.Test): request.Test {
    return r.set('Authorization', `Bearer ${this.token}`);
  }
  get = (url: string) => this.with(request(this.server).get(url));
  post = (url: string, body?: object) => this.with(request(this.server).post(url)).send(body);
  patch = (url: string, body?: object) => this.with(request(this.server).patch(url)).send(body);
  delete = (url: string, body?: object) => {
    const r = this.with(request(this.server).delete(url));
    return body ? r.send(body) : r;
  };
}
