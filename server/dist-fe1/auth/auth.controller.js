var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, HttpCode, Post, Req, Res, } from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService, SESSION_COOKIE, SESSION_TTL_MS } from './auth.service.js';
import { Auth, Public, RequireUser, } from './request-context.js';
class SignupDto {
    name;
    email;
    password;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(100),
    __metadata("design:type", String)
], SignupDto.prototype, "name", void 0);
__decorate([
    IsEmail(),
    __metadata("design:type", String)
], SignupDto.prototype, "email", void 0);
__decorate([
    IsString(),
    MinLength(8),
    MaxLength(200),
    __metadata("design:type", String)
], SignupDto.prototype, "password", void 0);
class LoginDto {
    email;
    password;
}
__decorate([
    IsEmail(),
    __metadata("design:type", String)
], LoginDto.prototype, "email", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(200),
    __metadata("design:type", String)
], LoginDto.prototype, "password", void 0);
export function setSessionCookie(res, raw) {
    res.cookie(SESSION_COOKIE, raw, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_TTL_MS,
    });
}
let AuthController = class AuthController {
    auth;
    constructor(auth) {
        this.auth = auth;
    }
    async signup(dto, req, res) {
        const user = await this.auth.createUser(dto);
        const session = await this.auth.createSession(user.id, req.headers['user-agent']);
        setSessionCookie(res, session.raw);
        return { user, workspaces: [] };
    }
    async login(dto, req, res) {
        const user = await this.auth.verifyCredentials(dto.email, dto.password);
        const session = await this.auth.createSession(user.id, req.headers['user-agent']);
        setSessionCookie(res, session.raw);
        return { user, workspaces: await this.auth.workspacesOf(user.id) };
    }
    async logout(auth, res) {
        if (auth.sessionId)
            await this.auth.destroySession(auth.sessionId);
        res.clearCookie(SESSION_COOKIE, { path: '/' });
    }
    async me(auth) {
        return { user: auth.user, workspaces: await this.auth.workspacesOf(auth.user.id) };
    }
};
__decorate([
    Public(),
    Post('signup'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [SignupDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "signup", null);
__decorate([
    Public(),
    Post('login'),
    HttpCode(200),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [LoginDto, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    Post('logout'),
    HttpCode(204),
    RequireUser(),
    __param(0, Auth()),
    __param(1, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    Get('me'),
    RequireUser(),
    __param(0, Auth()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "me", null);
AuthController = __decorate([
    Controller('auth'),
    __metadata("design:paramtypes", [AuthService])
], AuthController);
export { AuthController };
//# sourceMappingURL=auth.controller.js.map