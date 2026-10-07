var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { Wire } from '../database/entities/wire.js';
import { ArtifactEntity, IntegrationConnectionEntity } from '../database/entities/index.js';
let WebhookDeliveryEntity = class WebhookDeliveryEntity extends Wire {
    id;
    connectionId;
    receivedAt;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], WebhookDeliveryEntity.prototype, "id", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], WebhookDeliveryEntity.prototype, "connectionId", void 0);
__decorate([
    Column({ type: 'timestamptz', default: () => 'now()' }),
    __metadata("design:type", Date)
], WebhookDeliveryEntity.prototype, "receivedAt", void 0);
WebhookDeliveryEntity = __decorate([
    Entity('webhook_deliveries'),
    Index('IDX_webhook_deliveries_received', ['receivedAt']),
    ForeignKey(() => IntegrationConnectionEntity, ['connectionId'], ['id'], { onDelete: 'CASCADE' })
], WebhookDeliveryEntity);
export { WebhookDeliveryEntity };
let ArtifactSourceEntity = class ArtifactSourceEntity extends Wire {
    artifactId;
    workspaceId;
    repositoryId;
    headSha;
    headBranch;
};
__decorate([
    PrimaryColumn({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactSourceEntity.prototype, "artifactId", void 0);
__decorate([
    Column({ type: 'varchar' }),
    __metadata("design:type", String)
], ArtifactSourceEntity.prototype, "workspaceId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactSourceEntity.prototype, "repositoryId", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactSourceEntity.prototype, "headSha", void 0);
__decorate([
    Column({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ArtifactSourceEntity.prototype, "headBranch", void 0);
ArtifactSourceEntity = __decorate([
    Entity('artifact_sources'),
    Index('IDX_artifact_sources_repo_sha', ['repositoryId', 'headSha']),
    ForeignKey(() => ArtifactEntity, ['artifactId'], ['id'], { onDelete: 'CASCADE' })
], ArtifactSourceEntity);
export { ArtifactSourceEntity };
export const INTEGRATION_ENTITIES = [WebhookDeliveryEntity, ArtifactSourceEntity];
//# sourceMappingURL=entities.js.map