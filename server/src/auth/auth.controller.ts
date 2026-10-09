import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import type { Repository } from 'typeorm';
import { API_PERMISSIONS } from '../contracts/domain.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { AuthService, LEGACY_SESSION_COOKIE, SESSION_COOKIE, SESSION_TTL_MS } from './auth.service.js';
import {
  AllowCustomToken,
  Auth,
  Public,
  RequireUser,
  type AppRequest,
  type AuthInfo,
} from './request-context.js';

class SignupDto {
  @IsString() @MinLength(1) @MaxLength(100) name: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(200) password: string;
}

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}

/** Flags shared by set and clear. A clear that omits these leaves the browser holding the old cookie. */
function sessionCookieFlags() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

export function setSessionCookie(res: Response, raw: string): void {
  res.cookie(SESSION_COOKIE, raw, { ...sessionCookieFlags(), maxAge: SESSION_TTL_MS });
  res.clearCookie(LEGACY_SESSION_COOKIE, sessionCookieFlags());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieFlags());
  res.clearCookie(LEGACY_SESSION_COOKIE, sessionCookieFlags());
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @InjectRepository(WorkspaceEntity) private readonly workspaces: Repository<WorkspaceEntity>,
  ) {}

  @Public()
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.createUser(dto);
    const session = await this.auth.createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, session.raw);
    return { user, workspaces: [] };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.verifyCredentials(dto.email, dto.password);
    const session = await this.auth.createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, session.raw);
    return { user, workspaces: await this.auth.workspacesOf(user.id) };
  }

  @Post('logout')
  @HttpCode(204)
  @RequireUser()
  async logout(@Auth() auth: AuthInfo, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (auth.sessionId) await this.auth.destroySession(auth.sessionId);
    clearSessionCookie(res);
  }

  @Get('me')
  @RequireUser()
  async me(@Auth() auth: AuthInfo) {
    const workspaces = await this.auth.workspacesOf(auth.user!.id);
    // an API token belongs to one workspace: it does not learn about the user's others
    return { user: auth.user, workspaces: auth.token ? workspaces.filter((w) => w.id === auth.token!.workspaceId) : workspaces };
  }

  /**
   * Introspection for API-token clients (the MCP server): which workspace the token belongs to and
   * what it may do, so a client needs nothing but the key.
   */
  @Get('token')
  @AllowCustomToken()
  async token(@Auth() auth: AuthInfo) {
    const token = auth.token;
    if (!token) throw new ForbiddenException('Call this endpoint with an API token');
    const workspace = await this.workspaces.findOneByOrFail({ id: token.workspaceId });
    const permissions =
      token.scope === 'custom' ? (token.permissions ?? []) : token.scope === 'read' ? API_PERMISSIONS.filter((p) => p.endsWith(':read')) : API_PERMISSIONS;
    return {
      token,
      actor: auth.actor,
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      permissions,
    };
  }
}
