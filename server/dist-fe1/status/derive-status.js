import { TERMINAL_EXECUTION_STATES, } from '../contracts/domain.js';
const isTerminal = (s) => TERMINAL_EXECUTION_STATES.includes(s);
const isPr = (a) => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a) => isPr(a) && a.state === 'open';
export function blockers(input) {
    const out = [];
    for (const e of input.executions)
        if (e.state === 'blocked')
            out.push({ kind: 'execution_blocked', executionId: e.id });
    for (const e of input.executions) {
        if (e.state !== 'failed')
            continue;
        const retried = input.executions.some((o) => o.id !== e.id &&
            o.state === 'completed' &&
            (o.parentExecutionId ?? null) === (e.parentExecutionId ?? null) &&
            o.createdAt.getTime() > e.createdAt.getTime());
        if (!retried)
            out.push({ kind: 'execution_failed', executionId: e.id });
    }
    for (const a of input.artifacts) {
        if (!isOpenPr(a))
            continue;
        if (a.ci === 'failing')
            out.push({ kind: 'ci_failing', artifactId: a.id });
        if (a.hasConflicts)
            out.push({ kind: 'conflict', artifactId: a.id });
    }
    input.incomingDependencies.forEach((d, i) => {
        if (d.targetExecutionState && isTerminal(d.targetExecutionState))
            return;
        const resolved = d.sourceType === 'workstream' ? d.sourceState === 'shipped' : d.sourceState === 'completed';
        if (!resolved)
            out.push({ kind: 'dependency', dependencyIndex: i });
    });
    return out;
}
export function deriveStatus(input) {
    const override = input.workstream.statusOverride ?? null;
    const derived = deriveWithoutOverride(input);
    if (override)
        return { status: override, derivedStatus: derived.status, rule: 1 };
    return { status: derived.status, derivedStatus: derived.status, rule: derived.rule };
}
function deriveWithoutOverride(input) {
    const { executions, artifacts } = input;
    const prs = artifacts.filter(isPr);
    const deployed = artifacts.some((a) => (a.kind === 'deployment' && a.state === 'healthy') || (a.kind === 'release' && a.state === 'published'));
    const live = prs.filter((a) => a.state !== 'closed');
    const merged = live.length > 0 && live.every((a) => a.state === 'merged');
    if (deployed || (merged && executions.every((e) => isTerminal(e.state))))
        return { status: 'shipped', rule: 2 };
    if (blockers(input).length)
        return { status: 'blocked', rule: 3 };
    if (input.inputRequests.some((r) => r.state === 'open') ||
        executions.some((e) => e.state === 'needs_input') ||
        input.decisions.some((d) => d.status === 'proposed'))
        return { status: 'needs_input', rule: 4 };
    if (artifacts.some((a) => isOpenPr(a) && a.review === 'approved' && a.ci === 'passing' && !a.hasConflicts))
        return { status: 'ready_to_land', rule: 5 };
    if (artifacts.some(isOpenPr) || executions.some((e) => e.state === 'in_review'))
        return { status: 'in_review', rule: 6 };
    if (executions.some((e) => e.state === 'running'))
        return { status: 'working', rule: 7 };
    if (executions.length > 0 || input.workstream.acceptanceCriteria.length > 0)
        return { status: 'planned', rule: 8 };
    return { status: 'draft', rule: 9 };
}
//# sourceMappingURL=derive-status.js.map