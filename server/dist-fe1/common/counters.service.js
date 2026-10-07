var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@nestjs/common';
let CountersService = class CountersService {
    async next(m, workspaceId, name) {
        const rows = await m.query(`INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,1)
       ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = "workspace_counters"."value" + 1
       RETURNING "value"`, [workspaceId, name]);
        return rows[0].value;
    }
    async bumpTo(m, workspaceId, name, value) {
        await m.query(`INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3)
       ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", $3)`, [workspaceId, name, value]);
    }
};
CountersService = __decorate([
    Injectable()
], CountersService);
export { CountersService };
//# sourceMappingURL=counters.service.js.map