import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AiMessage } from './ai-provider.js';

interface LoginAttempt {
  process: ChildProcess;
  output: string;
  code: string | null;
  url: string | null;
  error: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

@Injectable()
export class GrokBuildService {
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly cliPath = process.env.GROK_CLI_PATH?.trim() || 'grok';
  private readonly homeRoot = process.env.GROK_HOME_DIR?.trim();

  status(userId: string) {
    return this.homeRoot
      ? this.hasCredentials(userId).then((connected) => ({
          available: true,
          connected,
          login: this.loginDetails(userId),
        }))
      : Promise.resolve({
          available: false,
          connected: false,
          login: null,
        });
  }

  async startLogin(userId: string) {
    const home = await this.userHome(userId);
    if (await this.hasCredentials(userId)) return { connected: true };
    const current = this.attempts.get(userId);
    if (current && current.process.exitCode === null)
      return this.loginDetails(userId);
    if (this.attempts.size >= 20)
      throw new ConflictException('Too many Grok login sessions are active.');

    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'XAI_API_KEY' && !key.startsWith('GROK_'),
      ),
    );
    const child = spawn(this.cliPath, ['login', '--device-auth'], {
      env: { ...inheritedEnvironment, GROK_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const attempt: LoginAttempt = {
      process: child,
      output: '',
      code: null,
      url: null,
      error: null,
      timer: null,
    };
    attempt.timer = setTimeout(() => {
      child.kill('SIGTERM');
      attempt.error = 'The Grok device code expired. Start a new login.';
    }, 10 * 60_000);
    this.attempts.set(userId, attempt);
    const consume = (chunk: Buffer) => {
      attempt.output = `${attempt.output}${chunk.toString('utf8')}`.slice(-16000);
      const ansiCode = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
      const plainOutput = attempt.output.replace(ansiCode, '');
      attempt.code ??=
        plainOutput.match(/\b(?:user\s+)?code\s*[:：]?\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/i)?.[1] ??
        null;
      const candidate = attempt.output.match(/https:\/\/[^\s"'<>]+/)?.[0];
      if (candidate) {
        try {
          const url = new URL(candidate.replace(/[),.;]+$/, ''));
          if (
            url.hostname === 'grok.com' ||
            url.hostname.endsWith('.grok.com') ||
            url.hostname === 'auth.x.ai'
          )
            attempt.url = url.href;
        } catch {
          attempt.url = null;
        }
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', () => {
      attempt.error = 'The Grok Build CLI could not be started. Check GROK_CLI_PATH.';
    });
    child.once('exit', (code) => {
      if (attempt.timer) clearTimeout(attempt.timer);
      if (code !== 0 && !attempt.error)
        attempt.error = 'Grok login ended before the account was connected.';
    });
    return this.loginDetails(userId);
  }

  async disconnect(userId: string) {
    const home = await this.userHome(userId);
    const attempt = this.attempts.get(userId);
    if (attempt) {
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.process.kill('SIGTERM');
    }
    this.attempts.delete(userId);
    await this.runCli(['logout'], home, 10_000);
    return { connected: await this.hasCredentials(userId) };
  }

  async complete(userId: string, messages: AiMessage[], signal: AbortSignal) {
    if (!(await this.hasCredentials(userId)))
      throw new ServiceUnavailableException('Connect a SuperGrok account in AI settings.');
    const home = await this.userHome(userId);
    const requestHome = await mkdtemp(join(home, 'request-'));
    await chmod(requestHome, 0o700);
    await copyFile(join(home, 'auth.json'), join(requestHome, 'auth.json'));
    await chmod(join(requestHome, 'auth.json'), 0o600);
    const prompt = messages
      .map(({ role, content }) => `${role.toUpperCase()}\n${content}`)
      .join('\n\n');
    try {
      const output = await this.runCli(
        [
          '--no-auto-update',
          '--no-subagents',
          '--no-memory',
          '--disable-web-search',
          '--tools',
          '',
          '--max-turns',
          '1',
          '--cwd',
          requestHome,
          '--output-format',
          'plain',
          '-p',
          prompt,
        ],
        requestHome,
        60_000,
        signal,
      );
      if (!output.trim() || output.length > 16000)
        throw new BadGatewayException('Grok returned an invalid response.');
      return output.trim();
    } finally {
      try {
        await copyFile(join(requestHome, 'auth.json'), join(home, 'auth.json'));
        await chmod(join(home, 'auth.json'), 0o600);
      } finally {
        await rm(requestHome, { recursive: true, force: true });
      }
    }
  }

  private loginDetails(userId: string) {
    const attempt = this.attempts.get(userId);
    return attempt
      ? {
          connected: false,
          code: attempt.code,
          url: attempt.url,
          error: attempt.error,
        }
      : null;
  }

  private async hasCredentials(userId: string) {
    if (!this.homeRoot) return false;
    try {
      const credentials = await stat(join(await this.userHome(userId), 'auth.json'));
      return credentials.isFile();
    } catch {
      return false;
    }
  }

  private async userHome(userId: string) {
    if (!this.homeRoot)
      throw new ServiceUnavailableException('SuperGrok is not enabled by the server administrator.');
    const safeRoot = resolve(this.homeRoot);
    const directory = resolve(safeRoot, createHash('sha256').update(userId).digest('hex'));
    if (!directory.startsWith(`${safeRoot}/`))
      throw new ServiceUnavailableException('The Grok credential directory is invalid.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return directory;
  }

  private async runCli(
    args: string[],
    home: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error('Request cancelled.');
    return new Promise((resolveOutput, reject) => {
      const inheritedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== 'XAI_API_KEY' && !key.startsWith('GROK_'),
        ),
      );
      const child = spawn(this.cliPath, args, {
        env: { ...inheritedEnvironment, GROK_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolveOutput(output);
      };
      const abort = () => {
        child.kill('SIGTERM');
        finish(new Error('Request cancelled.'));
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new GatewayTimeoutException('The Grok request timed out.'));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(0, 256_000);
      });
      child.stderr?.on('data', () => undefined);
      child.once('error', () => finish(new ServiceUnavailableException('The Grok Build CLI is unavailable.')));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new BadGatewayException('Grok could not complete the request.'));
      });
    });
  }
}
