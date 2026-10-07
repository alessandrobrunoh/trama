export declare function extractKeys(texts: ReadonlyArray<string | null | undefined>, opts?: {
    ignoreCase?: boolean;
    known?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}): string[];
