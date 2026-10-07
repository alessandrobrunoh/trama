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
import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException, } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { LessThan } from 'typeorm';
import { MembershipEntity, SessionEntity, UserEntity, WorkspaceEntity, } from '../database/entities/index.js';
import { uid } from '../common/util.js';
export const SESSION_COOKIE = 'nabla_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const DUMMY_HASH_REF = () => DUMMY_HASH;
const hashSession = (raw) => createHash('sha256').update(raw).digest('hex');
let AuthService = class AuthService {
    users;
    sessions;
    memberships;
    constructor(users, sessions, memberships) {
        this.users = users;
        this.sessions = sessions;
        this.memberships = memberships;
    }
    hashPassword(password) {
        return argon2.hash(password);
    }
    async createUser(input) {
        const email = input.email.trim().toLowerCase();
        if (await this.users.existsBy({ email }))
            throw new ConflictException('Email already registered');
        return this.users.save(this.users.create({
            id: uid('usr'),
            name: input.name.trim(),
            email,
            passwordHash: await this.hashPassword(input.password),
            avatarHue: Math.floor(Math.random() * 360),
        }));
    }
    async verifyCredentials(emailRaw, password) {
        const user = await this.users.findOneBy({ email: emailRaw.trim().toLowerCase() });
        const hash = user?.passwordHash ?? (await DUMMY_HASH_REF());
        const ok = await argon2.verify(hash, password).catch(() => false);
        if (!user || !ok)
            throw new UnauthorizedException('Invalid email or password');
        return user;
    }
    async createSession(userId, userAgent) {
        const raw = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await this.sessions.save(this.sessions.create({ id: hashSession(raw), userId, expiresAt, userAgent: userAgent?.slice(0, 255) ?? null }));
        await this.sessions.delete({ expiresAt: LessThan(new Date()) });
        return { raw, expiresAt };
    }
    async authenticateSession(raw) {
        const id = hashSession(raw);
        const session = await this.sessions.findOneBy({ id });
        if (!session || session.expiresAt.getTime() < Date.now())
            return null;
        const user = await this.users.findOneBy({ id: session.userId });
        return user ? { user, sessionId: id } : null;
    }
    async destroySession(sessionId) {
        await this.sessions.delete({ id: sessionId });
    }
    async workspacesOf(userId) {
        const rows = await this.memberships
            .createQueryBuilder('m')
            .innerJoinAndMapOne('m.ws', WorkspaceEntity, 'w', 'w.id = m.workspaceId')
            .where('m.userId = :userId', { userId })
            .orderBy('w.createdAt', 'ASC')
            .getMany();
        return rows.map((m) => {
            const ws = m.ws;
            return Object.assign(ws, { role: m.role });
        });
    }
};
AuthService = __decorate([
    Injectable(),
    __param(0, InjectRepository(UserEntity)),
    __param(1, InjectRepository(SessionEntity)),
    __param(2, InjectRepository(MembershipEntity)),
    __metadata("design:paramtypes", [Function, Function, Function])
], AuthService);
export { AuthService };
const DUMMY_HASH = argon2.hash('nabla-timing-equalizer');
//# sourceMappingURL=auth.service.js.map