export declare function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean;
export declare function signGithub(secret: string, body: string | Buffer): string;
export declare function verifyGitlabToken(secret: string, header: string | undefined): boolean;
