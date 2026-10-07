import { NotFoundException } from '@nestjs/common';
export declare function uid(prefix: string): string;
export declare function notFound(entity: string, id: string): NotFoundException;
export declare function definedOnly<T extends object>(input: T): Partial<T>;
export declare function slugify(input: string): string;
export declare function unique<T>(items: readonly T[] | null | undefined): T[];
export declare function toDate(value: string | Date | null | undefined): Date | null | undefined;
