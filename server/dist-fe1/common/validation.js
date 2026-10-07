import { ValidateIf } from 'class-validator';
export const OptionalNotNull = () => ValidateIf((_obj, value) => value !== undefined);
export const Clearable = () => ValidateIf((_obj, value) => value !== undefined && value !== null);
//# sourceMappingURL=validation.js.map