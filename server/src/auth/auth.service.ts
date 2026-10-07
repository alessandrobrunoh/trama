import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { LessThan, type Repository } from 'typeorm';
import {
  MembershipEntity,
  SessionEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import type { Role } from '../contracts/domain.js';
import { uid } from '../common/util.js';

export const SESSION_COOKIE = 'nabla_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const DUMMY_HASH_REF = () => DUMMY_HASH;
const hashSession = (raw: string) => createHash('sha256').update(raw).digest('hex');

export type WorkspaceWithRole = WorkspaceEntity & { role: Role };

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
  ) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async createUser(input: { name: string; email: string; password: string }): Promise<UserEntity> {
    const email = input.email.trim().toLowerCase();
    if (await this.users.existsBy({ email })) throw new ConflictException('Email already registered');
    return this.users.save(
      this.users.create({
        id: uid('usr'),
        name: input.name.trim(),
        email,
        passwordHash: await this.hashPassword(input.password),
        avatarHue: Math.floor(Math.random() * 360),
      }),
    );
  }

  async verifyCredentials(emailRaw: string, password: string): Promise<UserEntity> {
    const user = await this.users.findOneBy({ email: emailRaw.trim().toLowerCase() });
    // Always verify something so timing doesn't reveal whether the email exists.
    const hash = user?.passwordHash ?? (await DUMMY_HASH_REF());
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');
    return user;
  }

  /** Creates a session row; returns the raw cookie value (only its sha256 is stored). */
  async createSession(userId: string, userAgent?: string): Promise<{ raw: string; expiresAt: Date }> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sessions.save(
      this.sessions.create({ id: hashSession(raw), userId, expiresAt, userAgent: userAgent?.slice(0, 255) ?? null }),
    );
    // opportunistic cleanup
    await this.sessions.delete({ expiresAt: LessThan(new Date()) });
    return { raw, expiresAt };
  }

  async authenticateSession(raw: string): Promise<{ user: UserEntity; sessionId: string } | null> {
    const id = hashSession(raw);
    const session = await this.sessions.findOneBy({ id });
    if (!session || session.expiresAt.getTime() < Date.now()) return null;
    const user = await this.users.findOneBy({ id: session.userId });
    return user ? { user, sessionId: id } : null;
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.sessions.delete({ id: sessionId });
  }

  /** Workspaces the user belongs to, with their role. */
  async workspacesOf(userId: string): Promise<WorkspaceWithRole[]> {
    const rows = await this.memberships
      .createQueryBuilder('m')
      .innerJoinAndMapOne('m.ws', WorkspaceEntity, 'w', 'w.id = m.workspaceId')
      .where('m.userId = :userId', { userId })
      .orderBy('w.createdAt', 'ASC')
      .getMany();
    return rows.map((m) => {
      const ws = (m as unknown as { ws: WorkspaceEntity }).ws;
      return Object.assign(ws, { role: m.role });
    });
  }
}

/** Real argon2 hash used to equalize timing for unknown emails. */
const DUMMY_HASH = argon2.hash('nabla-timing-equalizer');
