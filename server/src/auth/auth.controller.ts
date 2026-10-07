import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { AuthService, SESSION_COOKIE, SESSION_TTL_MS } from './auth.service.js';
import {
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

export function setSessionCookie(res: Response, raw: string): void {
  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  @RequireUser()
  async me(@Auth() auth: AuthInfo) {
    return { user: auth.user, workspaces: await this.auth.workspacesOf(auth.user!.id) };
  }
}
