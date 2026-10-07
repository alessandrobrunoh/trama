var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var WorkstreamBus_1;
import { Injectable, Logger } from '@nestjs/common';
let WorkstreamBus = WorkstreamBus_1 = class WorkstreamBus {
    logger = new Logger(WorkstreamBus_1.name);
    handlers = new Set();
    onTouched(handler) {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
    async touch(workspaceId, workstreamId, reason) {
        const event = { workspaceId, workstreamId, reason };
        for (const handler of this.handlers) {
            try {
                await handler(event);
            }
            catch (error) {
                this.logger.error(`WorkstreamTouched handler failed: ${error.message}`);
            }
        }
    }
    async touchMany(workspaceId, workstreamIds, reason) {
        for (const id of new Set(workstreamIds))
            await this.touch(workspaceId, id, reason);
    }
};
WorkstreamBus = WorkstreamBus_1 = __decorate([
    Injectable()
], WorkstreamBus);
export { WorkstreamBus };
//# sourceMappingURL=workstream-bus.js.map