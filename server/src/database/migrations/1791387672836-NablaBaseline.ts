import { MigrationInterface, QueryRunner } from 'typeorm';

/** Full Nabla schema (replaces the Linear-clone prototype schema). */
export class NablaBaseline1791387672836 implements MigrationInterface {
  name = 'NablaBaseline1791387672836';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" character varying NOT NULL, "name" character varying NOT NULL, "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "avatarHue" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email" ON "users" ("email")`,
    );
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" character varying NOT NULL, "userId" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "userAgent" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sessions_user" ON "sessions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "workspaces" ("id" character varying NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_098656ae401f3e1a4586f47fd8e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workspaces_slug" ON "workspaces" ("slug")`,
    );
    await queryRunner.query(
      `CREATE TABLE "memberships" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "userId" character varying NOT NULL, "role" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_25d28bd932097a9e90495ede7b4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_memberships_user" ON "memberships" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_memberships_workspace_user" ON "memberships" ("workspaceId", "userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "agents" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "name" character varying NOT NULL, "provider" character varying NOT NULL, "description" text, "ownerUserId" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9c653f28ae19c5884d5baf6a1d9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_agents_workspace" ON "agents" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "teams" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "name" character varying NOT NULL, "key" character varying NOT NULL, "color" character varying NOT NULL DEFAULT '#6b7280', "description" text, "memberIds" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "PK_7e5523774a38b08a6236d322403" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_teams_workspace_key" ON "teams" ("workspaceId", "key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "repositories" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "provider" character varying NOT NULL, "fullName" character varying NOT NULL, "url" character varying NOT NULL, "defaultBranch" character varying NOT NULL DEFAULT 'main', "teamIds" jsonb NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ef0c358c04b4f4d29b8ca68ddff" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_repositories_workspace_name" ON "repositories" ("workspaceId", "provider", "fullName")`,
    );
    await queryRunner.query(
      `CREATE TABLE "workstreams" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "key" character varying NOT NULL, "number" integer NOT NULL, "title" character varying NOT NULL, "objective" text NOT NULL DEFAULT '', "context" text, "ownerTeamId" character varying NOT NULL, "participatingTeamIds" jsonb NOT NULL DEFAULT '[]', "accountableUserId" character varying, "repositoryIds" jsonb NOT NULL DEFAULT '[]', "acceptanceCriteria" jsonb NOT NULL DEFAULT '[]', "priority" character varying NOT NULL DEFAULT 'none', "labels" jsonb NOT NULL DEFAULT '[]', "status" character varying NOT NULL DEFAULT 'draft', "derivedStatus" character varying NOT NULL DEFAULT 'draft', "statusOverride" character varying, "targetDate" TIMESTAMP WITH TIME ZONE, "createdById" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "shippedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_4537fd32f0afc72db3adc425806" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workstreams_workspace_team" ON "workstreams" ("workspaceId", "ownerTeamId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workstreams_workspace_key" ON "workstreams" ("workspaceId", "key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "executions" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "workstreamId" character varying NOT NULL, "parentExecutionId" character varying, "title" character varying NOT NULL, "description" text, "teamId" character varying, "repositoryIds" jsonb NOT NULL DEFAULT '[]', "performers" jsonb NOT NULL DEFAULT '[]', "provider" character varying NOT NULL DEFAULT 'human', "state" character varying NOT NULL DEFAULT 'queued', "sessionUrl" character varying, "branch" character varying, "progressNote" text, "startedAt" TIMESTAMP WITH TIME ZONE, "completedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_703e64e0ef651986191844b7b8b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_executions_workstream" ON "executions" ("workstreamId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_executions_workspace" ON "executions" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "input_requests" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "workstreamId" character varying NOT NULL, "executionId" character varying, "question" text NOT NULL, "options" jsonb, "requestedBy" jsonb NOT NULL, "assigneeUserId" character varying, "state" character varying NOT NULL DEFAULT 'open', "answer" text, "answeredById" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "answeredAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_cf758ffe3840e3b9ca37b7e0f5f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_input_requests_workstream" ON "input_requests" ("workstreamId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_input_requests_workspace" ON "input_requests" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "intake_items" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "key" character varying NOT NULL, "number" integer NOT NULL, "kind" character varying NOT NULL, "title" character varying NOT NULL, "body" text, "source" character varying NOT NULL DEFAULT 'manual', "reporterName" character varying, "reporterId" character varying, "teamId" character varying, "priority" character varying NOT NULL DEFAULT 'none', "state" character varying NOT NULL DEFAULT 'new', "workstreamIds" jsonb NOT NULL DEFAULT '[]', "duplicateOfId" character varying, "externalUrl" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5adc2403c5aeea4b98f6deb5024" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_intake_workspace_key" ON "intake_items" ("workspaceId", "key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "artifacts" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "workstreamId" character varying NOT NULL, "executionId" character varying, "repositoryId" character varying, "kind" character varying NOT NULL, "provider" character varying NOT NULL DEFAULT 'other', "title" character varying NOT NULL, "url" character varying, "externalId" character varying, "state" character varying NOT NULL DEFAULT 'open', "ci" character varying, "review" character varying, "hasConflicts" boolean, "environment" character varying, "authorRef" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6516bbed3c129918e05c5012edb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_external" ON "artifacts" ("workspaceId", "repositoryId", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_workstream" ON "artifacts" ("workstreamId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_artifacts_workspace" ON "artifacts" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "decisions" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "key" character varying NOT NULL, "number" integer NOT NULL, "title" character varying NOT NULL, "statement" text NOT NULL, "rationale" text, "status" character varying NOT NULL DEFAULT 'proposed', "originWorkstreamId" character varying, "originExecutionId" character varying, "relatedWorkstreamIds" jsonb NOT NULL DEFAULT '[]', "supersededById" character varying, "proposedBy" jsonb NOT NULL, "decidedById" character varying, "decidedAt" TIMESTAMP WITH TIME ZONE, "tags" jsonb NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_48eee6fa229cd5e43648f6a2ec3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_decisions_workspace_key" ON "decisions" ("workspaceId", "key")`,
    );
    await queryRunner.query(
      `CREATE TABLE "dependencies" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "fromType" character varying NOT NULL, "fromId" character varying NOT NULL, "toType" character varying NOT NULL, "toId" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9f1f03f8207f8df418ae3eca645" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dependencies_from" ON "dependencies" ("workspaceId", "fromId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dependencies_to" ON "dependencies" ("workspaceId", "toId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_dependencies_edge" ON "dependencies" ("workspaceId", "fromType", "fromId", "toType", "toId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "comments" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "subject" jsonb NOT NULL, "author" jsonb NOT NULL, "body" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8bf68bc960f2b69e818bdb90dcb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_comments_workspace" ON "comments" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "domain_events" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "actor" jsonb NOT NULL, "type" character varying NOT NULL, "subject" jsonb NOT NULL, "workstreamId" character varying, "data" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_66e0920a32dda3a89b46ee7a981" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_events_workstream_at" ON "domain_events" ("workspaceId", "workstreamId", "at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_events_workspace_at" ON "domain_events" ("workspaceId", "at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "saved_views" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "ownerId" character varying NOT NULL, "name" character varying NOT NULL, "entity" character varying NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "sort" jsonb, "groupBy" character varying, "layout" character varying NOT NULL DEFAULT 'list', "shared" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_30acd4fbe2058d97631ab9bb2b6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_views_workspace" ON "saved_views" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "api_tokens" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "name" character varying NOT NULL, "prefix" character varying NOT NULL, "tokenHash" character varying NOT NULL, "actor" jsonb NOT NULL, "createdByUserId" character varying, "lastUsedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c587455266b5fa8dace7194caac" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_tokens_workspace" ON "api_tokens" ("workspaceId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_api_tokens_hash" ON "api_tokens" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE TABLE "attention_state" ("userId" character varying NOT NULL, "workspaceId" character varying NOT NULL, "itemId" character varying NOT NULL, "state" character varying NOT NULL, "snoozedUntil" TIMESTAMP WITH TIME ZONE, "since" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_b766a6e9c0b303ae4ad3a07560c" PRIMARY KEY ("userId", "workspaceId", "itemId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "workspace_counters" ("workspaceId" character varying NOT NULL, "name" character varying NOT NULL, "value" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_5bc79e5c771e94538eac3d63859" PRIMARY KEY ("workspaceId", "name"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "integration_connections" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "provider" character varying NOT NULL, "account" character varying NOT NULL, "baseUrl" character varying, "secret" text, "webhookSecret" text, "status" character varying NOT NULL DEFAULT 'connected', "lastSyncAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "config" jsonb NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b1ec518bfa5fa7404045412de2e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_integrations_workspace" ON "integration_connections" ("workspaceId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "FK_57de40bc620f456c7311aa3a1e6" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD CONSTRAINT "FK_187d573e43b2c2aa3960df20b78" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD CONSTRAINT "FK_5a480a4394c7b8a74da1cb66a2f" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD CONSTRAINT "FK_b1956936c029d54a6b3c6ecede1" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD CONSTRAINT "FK_891465b3cee1cfe275594eb1cd7" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "teams" ADD CONSTRAINT "FK_3ca5ec3f5558bcfb54c76a1ef23" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repositories" ADD CONSTRAINT "FK_d206ec74e9609a06c7d2381d67b" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workstreams" ADD CONSTRAINT "FK_4ad999e186631f9fc65e412ffb0" FOREIGN KEY ("accountableUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workstreams" ADD CONSTRAINT "FK_772fb8302fe6511c37b3bf9b9ac" FOREIGN KEY ("ownerTeamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workstreams" ADD CONSTRAINT "FK_4b1ae124997c512be94eaa1abd6" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_a84f300c6312045ace7d0215f9b" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_d17140a75ac99b25a6e706bdd94" FOREIGN KEY ("parentExecutionId") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_836070047b5e3fdc1e492e93b1f" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_1d82a6925833c6a58a27de62d37" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" ADD CONSTRAINT "FK_18e415fd594967e36dafeb6d3c1" FOREIGN KEY ("assigneeUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" ADD CONSTRAINT "FK_21f993cd58682aa1b2761e9af99" FOREIGN KEY ("executionId") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" ADD CONSTRAINT "FK_6668744227c4c46afdab5d048fd" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" ADD CONSTRAINT "FK_33c9a647553fe590bc89b0200d4" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_items" ADD CONSTRAINT "FK_dab116a864c6a85a2b0de2ca14f" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_items" ADD CONSTRAINT "FK_49108b2777a7ec5c615175dd3ca" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_6eb8eb2f15e2db01de4f143b4bc" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_771b15dfd916a9a3d1b28ba0f93" FOREIGN KEY ("executionId") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_cac8e5a5b5bede42039a360dcbc" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_02f6c8c3b32471516031067f0c8" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decisions" ADD CONSTRAINT "FK_ef87eac1479a7a6065dfa4caeba" FOREIGN KEY ("originExecutionId") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decisions" ADD CONSTRAINT "FK_c6697a687945aabef4353ee5c19" FOREIGN KEY ("originWorkstreamId") REFERENCES "workstreams"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "decisions" ADD CONSTRAINT "FK_acfd0f2a8add29dd36e4b7ccfb3" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "dependencies" ADD CONSTRAINT "FK_28320b89b083f4aee01e6d4ecb6" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "comments" ADD CONSTRAINT "FK_9e54f4464009dbc27921fd5f166" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "domain_events" ADD CONSTRAINT "FK_78616e6558d701bb98211411567" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "saved_views" ADD CONSTRAINT "FK_b1a4bbe136fd0fd124e5b76fe63" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "saved_views" ADD CONSTRAINT "FK_c0f0d3f489621a016ee658574e9" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_tokens" ADD CONSTRAINT "FK_e1efb31c1fda7f9c136d2bd5f3c" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attention_state" ADD CONSTRAINT "FK_04be089d65ce04b39692e331aa6" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attention_state" ADD CONSTRAINT "FK_4548f276ced2e4136c20193175d" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_counters" ADD CONSTRAINT "FK_42038b9917abec1989e5d105f19" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_connections" ADD CONSTRAINT "FK_7a298f1bf6779ccdea2b19ef456" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_comments_subject" ON "comments" (("subject"->>'id'))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_events_subject" ON "domain_events" (("workspaceId"), (("subject"->>'id')), "at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_events_subject"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_comments_subject"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integration_connections" DROP CONSTRAINT "FK_7a298f1bf6779ccdea2b19ef456"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_counters" DROP CONSTRAINT "FK_42038b9917abec1989e5d105f19"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attention_state" DROP CONSTRAINT "FK_4548f276ced2e4136c20193175d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attention_state" DROP CONSTRAINT "FK_04be089d65ce04b39692e331aa6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_tokens" DROP CONSTRAINT "FK_e1efb31c1fda7f9c136d2bd5f3c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "saved_views" DROP CONSTRAINT "FK_c0f0d3f489621a016ee658574e9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "saved_views" DROP CONSTRAINT "FK_b1a4bbe136fd0fd124e5b76fe63"`,
    );
    await queryRunner.query(
      `ALTER TABLE "domain_events" DROP CONSTRAINT "FK_78616e6558d701bb98211411567"`,
    );
    await queryRunner.query(
      `ALTER TABLE "comments" DROP CONSTRAINT "FK_9e54f4464009dbc27921fd5f166"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dependencies" DROP CONSTRAINT "FK_28320b89b083f4aee01e6d4ecb6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decisions" DROP CONSTRAINT "FK_acfd0f2a8add29dd36e4b7ccfb3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decisions" DROP CONSTRAINT "FK_c6697a687945aabef4353ee5c19"`,
    );
    await queryRunner.query(
      `ALTER TABLE "decisions" DROP CONSTRAINT "FK_ef87eac1479a7a6065dfa4caeba"`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" DROP CONSTRAINT "FK_02f6c8c3b32471516031067f0c8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" DROP CONSTRAINT "FK_cac8e5a5b5bede42039a360dcbc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" DROP CONSTRAINT "FK_771b15dfd916a9a3d1b28ba0f93"`,
    );
    await queryRunner.query(
      `ALTER TABLE "artifacts" DROP CONSTRAINT "FK_6eb8eb2f15e2db01de4f143b4bc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_items" DROP CONSTRAINT "FK_49108b2777a7ec5c615175dd3ca"`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_items" DROP CONSTRAINT "FK_dab116a864c6a85a2b0de2ca14f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" DROP CONSTRAINT "FK_33c9a647553fe590bc89b0200d4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" DROP CONSTRAINT "FK_6668744227c4c46afdab5d048fd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" DROP CONSTRAINT "FK_21f993cd58682aa1b2761e9af99"`,
    );
    await queryRunner.query(
      `ALTER TABLE "input_requests" DROP CONSTRAINT "FK_18e415fd594967e36dafeb6d3c1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_1d82a6925833c6a58a27de62d37"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_836070047b5e3fdc1e492e93b1f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_d17140a75ac99b25a6e706bdd94"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_a84f300c6312045ace7d0215f9b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workstreams" DROP CONSTRAINT "FK_4b1ae124997c512be94eaa1abd6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workstreams" DROP CONSTRAINT "FK_772fb8302fe6511c37b3bf9b9ac"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workstreams" DROP CONSTRAINT "FK_4ad999e186631f9fc65e412ffb0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repositories" DROP CONSTRAINT "FK_d206ec74e9609a06c7d2381d67b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teams" DROP CONSTRAINT "FK_3ca5ec3f5558bcfb54c76a1ef23"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" DROP CONSTRAINT "FK_891465b3cee1cfe275594eb1cd7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" DROP CONSTRAINT "FK_b1956936c029d54a6b3c6ecede1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" DROP CONSTRAINT "FK_5a480a4394c7b8a74da1cb66a2f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "memberships" DROP CONSTRAINT "FK_187d573e43b2c2aa3960df20b78"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_57de40bc620f456c7311aa3a1e6"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_integrations_workspace"`,
    );
    await queryRunner.query(
      `DROP TABLE "integration_connections"`,
    );
    await queryRunner.query(
      `DROP TABLE "workspace_counters"`,
    );
    await queryRunner.query(
      `DROP TABLE "attention_state"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_api_tokens_hash"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_api_tokens_workspace"`,
    );
    await queryRunner.query(
      `DROP TABLE "api_tokens"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_views_workspace"`,
    );
    await queryRunner.query(
      `DROP TABLE "saved_views"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_events_workspace_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_events_workstream_at"`,
    );
    await queryRunner.query(
      `DROP TABLE "domain_events"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_comments_workspace"`,
    );
    await queryRunner.query(
      `DROP TABLE "comments"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_dependencies_edge"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_dependencies_to"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_dependencies_from"`,
    );
    await queryRunner.query(
      `DROP TABLE "dependencies"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_decisions_workspace_key"`,
    );
    await queryRunner.query(
      `DROP TABLE "decisions"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_artifacts_workspace"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_artifacts_workstream"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_artifacts_external"`,
    );
    await queryRunner.query(
      `DROP TABLE "artifacts"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_intake_workspace_key"`,
    );
    await queryRunner.query(
      `DROP TABLE "intake_items"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_input_requests_workspace"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_input_requests_workstream"`,
    );
    await queryRunner.query(
      `DROP TABLE "input_requests"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_executions_workspace"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_executions_workstream"`,
    );
    await queryRunner.query(
      `DROP TABLE "executions"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_workstreams_workspace_key"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_workstreams_workspace_team"`,
    );
    await queryRunner.query(
      `DROP TABLE "workstreams"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_repositories_workspace_name"`,
    );
    await queryRunner.query(
      `DROP TABLE "repositories"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_teams_workspace_key"`,
    );
    await queryRunner.query(
      `DROP TABLE "teams"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_agents_workspace"`,
    );
    await queryRunner.query(
      `DROP TABLE "agents"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_memberships_workspace_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_memberships_user"`,
    );
    await queryRunner.query(
      `DROP TABLE "memberships"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_workspaces_slug"`,
    );
    await queryRunner.query(
      `DROP TABLE "workspaces"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_sessions_user"`,
    );
    await queryRunner.query(
      `DROP TABLE "sessions"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_users_email"`,
    );
    await queryRunner.query(
      `DROP TABLE "users"`,
    );
  }
}
