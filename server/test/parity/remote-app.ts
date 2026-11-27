import { DataSource } from 'typeorm';

/**
 * Base URL of the separately running Rust API the parity suite talks to. Set by
 * `vitest.config.parity.ts` / `scripts/parity-run.mjs`; empty in normal NestJS runs.
 * Read lazily so vitest's `test.env` is honored regardless of module import order.
 */
export function parityApiUrl(): string {
  return process.env.PARITY_API_URL ?? '';
}

/**
 * The database the Rust API was started against. Used only for the direct side-effect queries
 * (`app.get(DataSource)`) a few wire specs make; it is a dedicated disposable database, never
 * the shared `trama_core_test` the NestJS e2e suite recreates.
 */
export function parityDatabaseUrl(): string {
  return (
    process.env.PARITY_DATABASE_URL ??
    'postgres://delta:delta@localhost:5435/trama_parity'
  );
}

/**
 * A black-box stand-in for `INestApplication` that points `getHttpServer()` at the running Rust
 * API instead of an in-process NestJS app. supertest accepts a base URL string, so every
 * `request(server)` / `Client` / `TokenClient` call in the wire specs hits the Rust API over
 * real HTTP, with the same assertions.
 *
 * Supported surface (everything the `parity` specs in the manifest use):
 * - `getHttpServer()` → the base URL
 * - `get(DataSource)` → a connection to the parity DB, for direct side-effect queries
 * - `close()` → closes that connection
 *
 * Any other member throws: a spec that needs it does not belong in the parity classification.
 *
 * The cast to `INestApplication` is deliberate: the specs type their variable as the NestJS
 * interface, and unsupported members fail loudly at runtime instead of being weakened.
 */
export class RemoteApp {
  private readonly dataSource: DataSource;

  private constructor(
    private readonly baseUrl: string,
    dataSource: DataSource,
  ) {
    this.dataSource = dataSource;
  }

  /** Connects to the parity DB; call once per spec file, inside the async test setup. */
  static async connect(baseUrl: string): Promise<RemoteApp> {
    const dataSource = new DataSource({
      type: 'postgres',
      url: parityDatabaseUrl(),
    });
    await dataSource.initialize();
    return new RemoteApp(baseUrl, dataSource);
  }

  getHttpServer(): string {
    return this.baseUrl;
  }

  get(type: unknown): unknown {
    if (type === DataSource) return this.dataSource;
    throw new Error(
      `RemoteApp.get(${String(type)}) is not available in parity mode: the spec needs an ` +
        `in-process NestJS service. Classify it as provider-injection/in-process-only in ` +
        `test/parity/manifest.ts (see test/parity/README.md).`,
    );
  }

  async close(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }

  /** Unsupported `INestApplication` members fail loudly, so misclassified specs cannot pass vacuously. */
  private fail(member: string): never {
    throw new Error(
      `RemoteApp.${member} is not available in parity mode: the spec needs an in-process ` +
        `NestJS app. Reclassify it in test/parity/manifest.ts (see test/parity/README.md).`,
    );
  }

  listen(): never {
    this.fail('listen');
  }
  init(): never {
    this.fail('init');
  }
}
