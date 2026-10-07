export declare const ghRepo: {
    full_name: string;
    html_url: string;
    default_branch: string;
};
export declare function ghPullRequest(over?: Record<string, unknown>, action?: string): {
    action: string;
    number: number;
    repository: {
        full_name: string;
        html_url: string;
        default_branch: string;
    };
    pull_request: {
        number: number;
        title: string;
        body: string;
        state: string;
        draft: boolean;
        merged: boolean;
        mergeable: null;
        mergeable_state: string;
        html_url: string;
        head: {
            sha: string;
            ref: string;
        };
        requested_reviewers: never[];
        requested_teams: never[];
    };
};
export declare const ghCheckSuite: (conclusion: string | null, status?: string, sha?: string) => {
    action: string;
    repository: {
        full_name: string;
        html_url: string;
        default_branch: string;
    };
    check_suite: {
        status: string;
        conclusion: string | null;
        head_sha: string;
        head_branch: string;
        pull_requests: {
            number: number;
        }[];
    };
};
export declare const ghCheckRun: (conclusion: string | null, status?: string) => {
    action: string;
    repository: {
        full_name: string;
        html_url: string;
        default_branch: string;
    };
    check_run: {
        status: string;
        conclusion: string | null;
        head_sha: string;
        pull_requests: never[];
    };
};
export declare const ghStatus: (state: string) => {
    state: string;
    sha: string;
    repository: {
        full_name: string;
        html_url: string;
        default_branch: string;
    };
};
export declare const glProject: {
    path_with_namespace: string;
    web_url: string;
    default_branch: string;
};
export declare function glMergeRequest(attrs?: Record<string, unknown>, extra?: Record<string, unknown>): {
    object_kind: string;
    project: {
        path_with_namespace: string;
        web_url: string;
        default_branch: string;
    };
    reviewers: never[];
    object_attributes: {
        iid: number;
        title: string;
        description: string;
        state: string;
        action: string;
        source_branch: string;
        url: string;
        last_commit: {
            id: string;
        };
        merge_status: string;
    };
};
export declare const glPipeline: (status: string, mrIid?: number) => {
    merge_request?: {
        iid: number;
    } | undefined;
    object_kind: string;
    project: {
        path_with_namespace: string;
        web_url: string;
        default_branch: string;
    };
    object_attributes: {
        id: number;
        status: string;
        sha: string;
        ref: string;
    };
};
