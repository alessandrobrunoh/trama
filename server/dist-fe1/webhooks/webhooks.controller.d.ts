import type { Request, Response } from 'express';
import { WebhooksService } from './webhooks.service.js';
export declare class WebhooksController {
    private readonly service;
    constructor(service: WebhooksService);
    private run;
    github(id: string, req: Request, res: Response): Promise<void>;
    gitlab(id: string, req: Request, res: Response): Promise<void>;
}
