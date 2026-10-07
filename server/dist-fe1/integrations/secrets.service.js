var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SecretsService_1;
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
const DEV_KEY_MATERIAL = 'nabla-dev-only-integration-key';
let SecretsService = SecretsService_1 = class SecretsService {
    logger = new Logger(SecretsService_1.name);
    key;
    constructor() {
        this.key = SecretsService_1.resolveKey(process.env.NABLA_ENCRYPTION_KEY ?? process.env.SECRETS_KEY, (m) => this.logger.warn(m));
    }
    static resolveKey(raw, warn = () => undefined) {
        const value = raw?.trim();
        if (!value) {
            if (process.env.NODE_ENV === 'production')
                throw new Error('NABLA_ENCRYPTION_KEY is required in production (integration secrets are encrypted at rest)');
            warn('!!! NABLA_ENCRYPTION_KEY is not set: using a FIXED, PUBLIC development key. Integration tokens are NOT safely encrypted. Set NABLA_ENCRYPTION_KEY (e.g. `openssl rand -base64 32`) before storing real credentials.');
            return createHash('sha256').update(DEV_KEY_MATERIAL).digest();
        }
        if (/^[0-9a-fA-F]{64}$/.test(value))
            return Buffer.from(value, 'hex');
        if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
            const b = Buffer.from(value, 'base64');
            if (b.length === 32)
                return b;
        }
        return createHash('sha256').update(value).digest();
    }
    encrypt(plain, aad) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(aad));
        const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
    }
    decrypt(payload, aad) {
        const [version, iv, tag, data] = payload.split(':');
        if (version !== 'v2' || !iv || !tag || !data)
            throw new Error('Unsupported secret format');
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    }
    static generateWebhookSecret() {
        return `whsec_${randomBytes(24).toString('base64url')}`;
    }
};
SecretsService = SecretsService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [])
], SecretsService);
export { SecretsService };
//# sourceMappingURL=secrets.service.js.map