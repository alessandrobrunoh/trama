import { Wire } from '../database/entities/wire.js';
export declare class WebhookDeliveryEntity extends Wire {
    id: string;
    connectionId: string;
    receivedAt: Date;
}
export declare class ArtifactSourceEntity extends Wire {
    artifactId: string;
    workspaceId: string;
    repositoryId: string | null;
    headSha: string | null;
    headBranch: string | null;
}
export declare const INTEGRATION_ENTITIES: (typeof WebhookDeliveryEntity | typeof ArtifactSourceEntity)[];
