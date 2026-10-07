import { SetMetadata, createParamDecorator, } from '@nestjs/common';
export const ROLE_RANK = {
    viewer: 0,
    member: 1,
    admin: 2,
    owner: 3,
};
export function hasRole(role, min) {
    return ROLE_RANK[role] >= ROLE_RANK[min];
}
export const IS_PUBLIC_KEY = 'nabla:public';
export const ROLES_KEY = 'nabla:roles';
export const REQUIRE_USER_KEY = 'nabla:require-user';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const Roles = (min) => SetMetadata(ROLES_KEY, min);
export const RequireUser = () => SetMetadata(REQUIRE_USER_KEY, true);
function req(ctx) {
    return ctx.switchToHttp().getRequest();
}
export const Ctx = createParamDecorator((_, ctx) => req(ctx).ctx);
export const Actor = createParamDecorator((_, ctx) => (req(ctx).ctx ?? req(ctx).auth).actor);
export const Auth = createParamDecorator((_, ctx) => req(ctx).auth);
//# sourceMappingURL=request-context.js.map