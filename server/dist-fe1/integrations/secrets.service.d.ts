export declare class SecretsService {
    private readonly logger;
    private readonly key;
    constructor();
    static resolveKey(raw: string | undefined, warn?: (m: string) => void): Buffer;
    encrypt(plain: string, aad: string): string;
    decrypt(payload: string, aad: string): string;
    static generateWebhookSecret(): string;
}
