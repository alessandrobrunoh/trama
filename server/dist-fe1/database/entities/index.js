var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Column, Entity, ForeignKey, Index, PrimaryColumn, } from 'typeorm';
import { Wire } from './wire.js';
export { Wire };
const NOW = () => 'now()';
const EMPTY_ARRAY = () => "'[]'";
const EMPTY_OBJECT = () => "'{}'";
let UserEntity = class UserEntity extends Wire {
    id;
    name;
    email;
    passwordHash;
    avatarHue;
    createdAt;
    hidden() {
        return ['passwordHash'];
    }
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], UserEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], UserEntity.prototype, "name", void 0);
__decorate([
    Index('UQ_users_email', { unique: true }),
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], UserEntity.prototype, "email", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], UserEntity.prototype, "passwordHash", void 0);
__decorate([
    Column({ type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], UserEntity.prototype, "avatarHue", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], UserEntity.prototype, "createdAt", void 0);
UserEntity = __decorate([
    Entity('users')
], UserEntity);
export { UserEntity };
let SessionEntity = class SessionEntity {
    id;
    userId;
    expiresAt;
    userAgent;
    createdAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], SessionEntity.prototype, "id", void 0);
__decorate([
    Index('IDX_sessions_user'),
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], SessionEntity.prototype, "userId", void 0);
__decorate([
    Column({ type: 'timestamptz' }),
    __metadata("design:type", Date)
], SessionEntity.prototype, "expiresAt", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], SessionEntity.prototype, "userAgent", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], SessionEntity.prototype, "createdAt", void 0);
SessionEntity = __decorate([
    Entity('sessions'),
    ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
], SessionEntity);
export { SessionEntity };
let WorkspaceEntity = class WorkspaceEntity extends Wire {
    id;
    name;
    slug;
    createdAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkspaceEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkspaceEntity.prototype, "name", void 0);
__decorate([
    Index('UQ_workspaces_slug', { unique: true }),
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkspaceEntity.prototype, "slug", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], WorkspaceEntity.prototype, "createdAt", void 0);
WorkspaceEntity = __decorate([
    Entity('workspaces')
], WorkspaceEntity);
export { WorkspaceEntity };
let MembershipEntity = class MembershipEntity extends Wire {
    id;
    workspaceId;
    userId;
    role;
    createdAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], MembershipEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], MembershipEntity.prototype, "workspaceId", void 0);
__decorate([
    Index('IDX_memberships_user'),
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], MembershipEntity.prototype, "userId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], MembershipEntity.prototype, "role", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], MembershipEntity.prototype, "createdAt", void 0);
MembershipEntity = __decorate([
    Entity('memberships'),
    Index('UQ_memberships_workspace_user', ['workspaceId', 'userId'], {
        unique: true,
    }),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
], MembershipEntity);
export { MembershipEntity };
let AgentEntity = class AgentEntity extends Wire {
    id;
    workspaceId;
    name;
    provider;
    description;
    ownerUserId;
    createdAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], AgentEntity.prototype, "id", void 0);
__decorate([
    Index('IDX_agents_workspace'),
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], AgentEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], AgentEntity.prototype, "name", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", Object)
], AgentEntity.prototype, "provider", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AgentEntity.prototype, "description", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], AgentEntity.prototype, "ownerUserId", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], AgentEntity.prototype, "createdAt", void 0);
AgentEntity = __decorate([
    Entity('agents'),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => UserEntity, ['ownerUserId'], ['id'], { onDelete: 'SET NULL' })
], AgentEntity);
export { AgentEntity };
let TeamEntity = class TeamEntity extends Wire {
    id;
    workspaceId;
    name;
    key;
    color;
    description;
    memberIds;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], TeamEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], TeamEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], TeamEntity.prototype, "name", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], TeamEntity.prototype, "key", void 0);
__decorate([
    Column({ type: 'varchar', default: '#6b7280' }),
    __metadata("design:type", String)
], TeamEntity.prototype, "color", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], TeamEntity.prototype, "description", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], TeamEntity.prototype, "memberIds", void 0);
TeamEntity = __decorate([
    Entity('teams'),
    Index('UQ_teams_workspace_key', ['workspaceId', 'key'], { unique: true }),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], TeamEntity);
export { TeamEntity };
let RepositoryEntity = class RepositoryEntity extends Wire {
    id;
    workspaceId;
    provider;
    fullName;
    url;
    defaultBranch;
    teamIds;
    createdAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], RepositoryEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], RepositoryEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], RepositoryEntity.prototype, "provider", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], RepositoryEntity.prototype, "fullName", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], RepositoryEntity.prototype, "url", void 0);
__decorate([
    Column({ type: 'varchar', default: 'main' }),
    __metadata("design:type", String)
], RepositoryEntity.prototype, "defaultBranch", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], RepositoryEntity.prototype, "teamIds", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], RepositoryEntity.prototype, "createdAt", void 0);
RepositoryEntity = __decorate([
    Entity('repositories'),
    Index('UQ_repositories_workspace_name', ['workspaceId', 'provider', 'fullName'], { unique: true }),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], RepositoryEntity);
export { RepositoryEntity };
let WorkstreamEntity = class WorkstreamEntity extends Wire {
    id;
    workspaceId;
    key;
    number;
    title;
    objective;
    context;
    ownerTeamId;
    participatingTeamIds;
    accountableUserId;
    repositoryIds;
    acceptanceCriteria;
    priority;
    labels;
    status;
    derivedStatus;
    statusOverride;
    targetDate;
    createdById;
    createdAt;
    updatedAt;
    shippedAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "key", void 0);
__decorate([
    Column({ type: 'integer' }),
    __metadata("design:type", Number)
], WorkstreamEntity.prototype, "number", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "title", void 0);
__decorate([
    Column({ type: 'text', default: '' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "objective", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], WorkstreamEntity.prototype, "context", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "ownerTeamId", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], WorkstreamEntity.prototype, "participatingTeamIds", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], WorkstreamEntity.prototype, "accountableUserId", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], WorkstreamEntity.prototype, "repositoryIds", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], WorkstreamEntity.prototype, "acceptanceCriteria", void 0);
__decorate([
    Column({ type: 'varchar', default: 'none' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "priority", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], WorkstreamEntity.prototype, "labels", void 0);
__decorate([
    Column({ type: 'varchar', default: 'draft' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "status", void 0);
__decorate([
    Column({ type: 'varchar', default: 'draft' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "derivedStatus", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], WorkstreamEntity.prototype, "statusOverride", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], WorkstreamEntity.prototype, "targetDate", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkstreamEntity.prototype, "createdById", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], WorkstreamEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], WorkstreamEntity.prototype, "updatedAt", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], WorkstreamEntity.prototype, "shippedAt", void 0);
WorkstreamEntity = __decorate([
    Entity('workstreams'),
    Index('UQ_workstreams_workspace_key', ['workspaceId', 'key'], {
        unique: true,
    }),
    Index('IDX_workstreams_workspace_team', ['workspaceId', 'ownerTeamId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => TeamEntity, ['ownerTeamId'], ['id'], { onDelete: 'RESTRICT' }),
    ForeignKey(() => UserEntity, ['accountableUserId'], ['id'], {
        onDelete: 'SET NULL',
    })
], WorkstreamEntity);
export { WorkstreamEntity };
let ExecutionEntity = class ExecutionEntity extends Wire {
    id;
    workspaceId;
    workstreamId;
    parentExecutionId;
    title;
    description;
    teamId;
    repositoryIds;
    performers;
    provider;
    state;
    sessionUrl;
    branch;
    progressNote;
    startedAt;
    completedAt;
    createdAt;
    updatedAt;
    dependsOnExecutionIds;
    hidden() {
        return ['workspaceId'];
    }
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], ExecutionEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ExecutionEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ExecutionEntity.prototype, "workstreamId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "parentExecutionId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ExecutionEntity.prototype, "title", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "description", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "teamId", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], ExecutionEntity.prototype, "repositoryIds", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], ExecutionEntity.prototype, "performers", void 0);
__decorate([
    Column({ type: 'varchar', default: 'human' }),
    __metadata("design:type", String)
], ExecutionEntity.prototype, "provider", void 0);
__decorate([
    Column({ type: 'varchar', default: 'queued' }),
    __metadata("design:type", String)
], ExecutionEntity.prototype, "state", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "sessionUrl", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "branch", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "progressNote", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "startedAt", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], ExecutionEntity.prototype, "completedAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], ExecutionEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], ExecutionEntity.prototype, "updatedAt", void 0);
ExecutionEntity = __decorate([
    Entity('executions'),
    Index('IDX_executions_workspace', ['workspaceId']),
    Index('IDX_executions_workstream', ['workstreamId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => WorkstreamEntity, ['workstreamId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => ExecutionEntity, ['parentExecutionId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => TeamEntity, ['teamId'], ['id'], { onDelete: 'SET NULL' })
], ExecutionEntity);
export { ExecutionEntity };
let InputRequestEntity = class InputRequestEntity extends Wire {
    id;
    workspaceId;
    workstreamId;
    executionId;
    question;
    options;
    requestedBy;
    assigneeUserId;
    state;
    answer;
    answeredById;
    createdAt;
    answeredAt;
    hidden() {
        return ['workspaceId'];
    }
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], InputRequestEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], InputRequestEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], InputRequestEntity.prototype, "workstreamId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "executionId", void 0);
__decorate([
    Column({ type: 'text' }),
    __metadata("design:type", String)
], InputRequestEntity.prototype, "question", void 0);
__decorate([
    Column({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "options", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "requestedBy", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "assigneeUserId", void 0);
__decorate([
    Column({ type: 'varchar', default: 'open' }),
    __metadata("design:type", String)
], InputRequestEntity.prototype, "state", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "answer", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "answeredById", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], InputRequestEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], InputRequestEntity.prototype, "answeredAt", void 0);
InputRequestEntity = __decorate([
    Entity('input_requests'),
    Index('IDX_input_requests_workspace', ['workspaceId']),
    Index('IDX_input_requests_workstream', ['workstreamId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => WorkstreamEntity, ['workstreamId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => ExecutionEntity, ['executionId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => UserEntity, ['assigneeUserId'], ['id'], {
        onDelete: 'SET NULL',
    })
], InputRequestEntity);
export { InputRequestEntity };
let IntakeItemEntity = class IntakeItemEntity extends Wire {
    id;
    workspaceId;
    key;
    number;
    kind;
    title;
    body;
    source;
    reporterName;
    reporterId;
    teamId;
    priority;
    state;
    workstreamIds;
    duplicateOfId;
    externalUrl;
    createdAt;
    updatedAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "key", void 0);
__decorate([
    Column({ type: 'integer' }),
    __metadata("design:type", Number)
], IntakeItemEntity.prototype, "number", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "kind", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "title", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], IntakeItemEntity.prototype, "body", void 0);
__decorate([
    Column({ type: 'varchar', default: 'manual' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "source", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IntakeItemEntity.prototype, "reporterName", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IntakeItemEntity.prototype, "reporterId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IntakeItemEntity.prototype, "teamId", void 0);
__decorate([
    Column({ type: 'varchar', default: 'none' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "priority", void 0);
__decorate([
    Column({ type: 'varchar', default: 'new' }),
    __metadata("design:type", String)
], IntakeItemEntity.prototype, "state", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], IntakeItemEntity.prototype, "workstreamIds", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IntakeItemEntity.prototype, "duplicateOfId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IntakeItemEntity.prototype, "externalUrl", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], IntakeItemEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], IntakeItemEntity.prototype, "updatedAt", void 0);
IntakeItemEntity = __decorate([
    Entity('intake_items'),
    Index('UQ_intake_workspace_key', ['workspaceId', 'key'], { unique: true }),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => TeamEntity, ['teamId'], ['id'], { onDelete: 'SET NULL' })
], IntakeItemEntity);
export { IntakeItemEntity };
let ArtifactEntity = class ArtifactEntity extends Wire {
    id;
    workspaceId;
    workstreamId;
    executionId;
    repositoryId;
    kind;
    provider;
    title;
    url;
    externalId;
    state;
    ci;
    review;
    hasConflicts;
    environment;
    authorRef;
    createdAt;
    updatedAt;
    hidden() {
        return ['workspaceId'];
    }
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "workstreamId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "executionId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "repositoryId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "kind", void 0);
__decorate([
    Column({ type: 'varchar', default: 'other' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "provider", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "title", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "url", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "externalId", void 0);
__decorate([
    Column({ type: 'varchar', default: 'open' }),
    __metadata("design:type", String)
], ArtifactEntity.prototype, "state", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "ci", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "review", void 0);
__decorate([
    Column({ type: 'boolean', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "hasConflicts", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "environment", void 0);
__decorate([
    Column({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], ArtifactEntity.prototype, "authorRef", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], ArtifactEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], ArtifactEntity.prototype, "updatedAt", void 0);
ArtifactEntity = __decorate([
    Entity('artifacts'),
    Index('IDX_artifacts_workspace', ['workspaceId']),
    Index('IDX_artifacts_workstream', ['workstreamId']),
    Index('IDX_artifacts_external', ['workspaceId', 'repositoryId', 'externalId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => WorkstreamEntity, ['workstreamId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => ExecutionEntity, ['executionId'], ['id'], {
        onDelete: 'SET NULL',
    }),
    ForeignKey(() => RepositoryEntity, ['repositoryId'], ['id'], {
        onDelete: 'SET NULL',
    })
], ArtifactEntity);
export { ArtifactEntity };
let DecisionEntity = class DecisionEntity extends Wire {
    id;
    workspaceId;
    key;
    number;
    title;
    statement;
    rationale;
    status;
    originWorkstreamId;
    originExecutionId;
    relatedWorkstreamIds;
    supersededById;
    proposedBy;
    decidedById;
    decidedAt;
    tags;
    createdAt;
    updatedAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], DecisionEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DecisionEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DecisionEntity.prototype, "key", void 0);
__decorate([
    Column({ type: 'integer' }),
    __metadata("design:type", Number)
], DecisionEntity.prototype, "number", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DecisionEntity.prototype, "title", void 0);
__decorate([
    Column({ type: 'text' }),
    __metadata("design:type", String)
], DecisionEntity.prototype, "statement", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "rationale", void 0);
__decorate([
    Column({ type: 'varchar', default: 'proposed' }),
    __metadata("design:type", String)
], DecisionEntity.prototype, "status", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "originWorkstreamId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "originExecutionId", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], DecisionEntity.prototype, "relatedWorkstreamIds", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "supersededById", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "proposedBy", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "decidedById", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DecisionEntity.prototype, "decidedAt", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], DecisionEntity.prototype, "tags", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], DecisionEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], DecisionEntity.prototype, "updatedAt", void 0);
DecisionEntity = __decorate([
    Entity('decisions'),
    Index('UQ_decisions_workspace_key', ['workspaceId', 'key'], { unique: true }),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => WorkstreamEntity, ['originWorkstreamId'], ['id'], {
        onDelete: 'SET NULL',
    }),
    ForeignKey(() => ExecutionEntity, ['originExecutionId'], ['id'], {
        onDelete: 'SET NULL',
    })
], DecisionEntity);
export { DecisionEntity };
let DependencyEntity = class DependencyEntity extends Wire {
    id;
    workspaceId;
    fromType;
    fromId;
    toType;
    toId;
    createdAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], DependencyEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DependencyEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DependencyEntity.prototype, "fromType", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DependencyEntity.prototype, "fromId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DependencyEntity.prototype, "toType", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DependencyEntity.prototype, "toId", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], DependencyEntity.prototype, "createdAt", void 0);
DependencyEntity = __decorate([
    Entity('dependencies'),
    Index('UQ_dependencies_edge', ['workspaceId', 'fromType', 'fromId', 'toType', 'toId'], { unique: true }),
    Index('IDX_dependencies_to', ['workspaceId', 'toId']),
    Index('IDX_dependencies_from', ['workspaceId', 'fromId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], DependencyEntity);
export { DependencyEntity };
let CommentEntity = class CommentEntity extends Wire {
    id;
    workspaceId;
    subject;
    author;
    body;
    createdAt;
    updatedAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], CommentEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], CommentEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], CommentEntity.prototype, "subject", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], CommentEntity.prototype, "author", void 0);
__decorate([
    Column({ type: 'text' }),
    __metadata("design:type", String)
], CommentEntity.prototype, "body", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], CommentEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], CommentEntity.prototype, "updatedAt", void 0);
CommentEntity = __decorate([
    Entity('comments'),
    Index('IDX_comments_workspace', ['workspaceId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], CommentEntity);
export { CommentEntity };
let DomainEventEntity = class DomainEventEntity extends Wire {
    id;
    workspaceId;
    at;
    actor;
    type;
    subject;
    workstreamId;
    data;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], DomainEventEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DomainEventEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], DomainEventEntity.prototype, "at", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], DomainEventEntity.prototype, "actor", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], DomainEventEntity.prototype, "type", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], DomainEventEntity.prototype, "subject", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], DomainEventEntity.prototype, "workstreamId", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_OBJECT }),
    __metadata("design:type", Object)
], DomainEventEntity.prototype, "data", void 0);
DomainEventEntity = __decorate([
    Entity('domain_events'),
    Index('IDX_events_workspace_at', ['workspaceId', 'at']),
    Index('IDX_events_workstream_at', ['workspaceId', 'workstreamId', 'at']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], DomainEventEntity);
export { DomainEventEntity };
let SavedViewEntity = class SavedViewEntity extends Wire {
    id;
    workspaceId;
    ownerId;
    name;
    entity;
    filters;
    sort;
    groupBy;
    layout;
    shared;
    createdAt;
    updatedAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], SavedViewEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], SavedViewEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], SavedViewEntity.prototype, "ownerId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], SavedViewEntity.prototype, "name", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], SavedViewEntity.prototype, "entity", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_ARRAY }),
    __metadata("design:type", Array)
], SavedViewEntity.prototype, "filters", void 0);
__decorate([
    Column({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], SavedViewEntity.prototype, "sort", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], SavedViewEntity.prototype, "groupBy", void 0);
__decorate([
    Column({ type: 'varchar', default: 'list' }),
    __metadata("design:type", String)
], SavedViewEntity.prototype, "layout", void 0);
__decorate([
    Column({ type: 'boolean', default: false }),
    __metadata("design:type", Boolean)
], SavedViewEntity.prototype, "shared", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], SavedViewEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], SavedViewEntity.prototype, "updatedAt", void 0);
SavedViewEntity = __decorate([
    Entity('saved_views'),
    Index('IDX_views_workspace', ['workspaceId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => UserEntity, ['ownerId'], ['id'], { onDelete: 'CASCADE' })
], SavedViewEntity);
export { SavedViewEntity };
let ApiTokenEntity = class ApiTokenEntity extends Wire {
    id;
    workspaceId;
    name;
    prefix;
    tokenHash;
    actor;
    createdByUserId;
    lastUsedAt;
    createdAt;
    expiresAt;
    hidden() {
        return ['tokenHash', 'createdByUserId'];
    }
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "name", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "prefix", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "tokenHash", void 0);
__decorate([
    Column({ type: 'jsonb' }),
    __metadata("design:type", Object)
], ApiTokenEntity.prototype, "actor", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ApiTokenEntity.prototype, "createdByUserId", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], ApiTokenEntity.prototype, "lastUsedAt", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], ApiTokenEntity.prototype, "createdAt", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], ApiTokenEntity.prototype, "expiresAt", void 0);
ApiTokenEntity = __decorate([
    Entity('api_tokens'),
    Index('UQ_api_tokens_hash', ['tokenHash'], { unique: true }),
    Index('IDX_api_tokens_workspace', ['workspaceId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], ApiTokenEntity);
export { ApiTokenEntity };
let AttentionStateEntity = class AttentionStateEntity {
    userId;
    workspaceId;
    itemId;
    state;
    snoozedUntil;
    since;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], AttentionStateEntity.prototype, "userId", void 0);
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], AttentionStateEntity.prototype, "workspaceId", void 0);
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], AttentionStateEntity.prototype, "itemId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], AttentionStateEntity.prototype, "state", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], AttentionStateEntity.prototype, "snoozedUntil", void 0);
__decorate([
    Column({ type: 'timestamptz' }),
    __metadata("design:type", Date)
], AttentionStateEntity.prototype, "since", void 0);
AttentionStateEntity = __decorate([
    Entity('attention_state'),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    }),
    ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
], AttentionStateEntity);
export { AttentionStateEntity };
let WorkspaceCounterEntity = class WorkspaceCounterEntity {
    workspaceId;
    name;
    value;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkspaceCounterEntity.prototype, "workspaceId", void 0);
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], WorkspaceCounterEntity.prototype, "name", void 0);
__decorate([
    Column({ type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], WorkspaceCounterEntity.prototype, "value", void 0);
WorkspaceCounterEntity = __decorate([
    Entity('workspace_counters'),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], WorkspaceCounterEntity);
export { WorkspaceCounterEntity };
let IntegrationConnectionEntity = class IntegrationConnectionEntity extends Wire {
    id;
    workspaceId;
    provider;
    account;
    baseUrl;
    secret;
    webhookSecret;
    status;
    lastSyncAt;
    lastError;
    config;
    createdAt;
    get webhookConfigured() {
        return !!this.webhookSecret;
    }
    hidden() {
        return ['secret', 'webhookSecret', 'config'];
    }
    toJSON() {
        return { ...super.toJSON(), webhookConfigured: this.webhookConfigured };
    }
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], IntegrationConnectionEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntegrationConnectionEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntegrationConnectionEntity.prototype, "provider", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], IntegrationConnectionEntity.prototype, "account", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IntegrationConnectionEntity.prototype, "baseUrl", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], IntegrationConnectionEntity.prototype, "secret", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], IntegrationConnectionEntity.prototype, "webhookSecret", void 0);
__decorate([
    Column({ type: 'varchar', default: 'connected' }),
    __metadata("design:type", String)
], IntegrationConnectionEntity.prototype, "status", void 0);
__decorate([
    Column({ type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], IntegrationConnectionEntity.prototype, "lastSyncAt", void 0);
__decorate([
    Column({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], IntegrationConnectionEntity.prototype, "lastError", void 0);
__decorate([
    Column({ type: 'jsonb', default: EMPTY_OBJECT }),
    __metadata("design:type", Object)
], IntegrationConnectionEntity.prototype, "config", void 0);
__decorate([
    Column({ type: 'timestamptz', default: NOW }),
    __metadata("design:type", Date)
], IntegrationConnectionEntity.prototype, "createdAt", void 0);
IntegrationConnectionEntity = __decorate([
    Entity('integration_connections'),
    Index('IDX_integrations_workspace', ['workspaceId']),
    ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
        onDelete: 'CASCADE',
    })
], IntegrationConnectionEntity);
export { IntegrationConnectionEntity };
export const ENTITIES = [
    UserEntity,
    SessionEntity,
    WorkspaceEntity,
    MembershipEntity,
    AgentEntity,
    TeamEntity,
    RepositoryEntity,
    WorkstreamEntity,
    ExecutionEntity,
    InputRequestEntity,
    IntakeItemEntity,
    ArtifactEntity,
    DecisionEntity,
    DependencyEntity,
    CommentEntity,
    DomainEventEntity,
    SavedViewEntity,
    ApiTokenEntity,
    AttentionStateEntity,
    WorkspaceCounterEntity,
    IntegrationConnectionEntity,
];
//# sourceMappingURL=index.js.map