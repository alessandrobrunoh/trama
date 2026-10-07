import { type SeedData } from './builder.js';
export declare const DEMO_EMAIL = "demo@nabla.dev";
export declare const DEMO_PASSWORD = "nabla-demo";
export declare function createSeed(now: number, passwordHash: string): SeedData;
