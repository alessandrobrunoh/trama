import { blockers } from '../status/derive-status.js';
export const DEADLINE_WINDOW_DAYS = 3;
const DAY = 86_400_000;
const isPr = (a) => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a) => isPr(a) && a.state === 'open';
const short = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function computeAttention(d) {
    const teams = new Map(d.teams.map((t) => [t.id, t]));
    const wsById = new Map(d.workstreams.map((w) => [w.id, w]));
    const exById = new Map(d.executions.map((e) => [e.id, e]));
    const sinceOf = (id, fallback) => d.since?.get(id) ?? fallback;
    const nameOf = (a) => (a.id ? (d.names.get(a.id) ?? a.id) : 'system');
    const relevant = (w) => {
        const s = new Set();
        if (w.accountableUserId)
            s.add(w.accountableUserId);
        for (const t of [w.ownerTeamId, ...w.participatingTeamIds])
            for (const u of teams.get(t)?.memberIds ?? [])
                s.add(u);
        return s;
    };
    const ownerSide = (w) => {
        const s = new Set();
        if (w.accountableUserId)
            s.add(w.accountableUserId);
        for (const u of teams.get(w.ownerTeamId)?.memberIds ?? [])
            s.add(u);
        return s;
    };
    const items = [];
    const active = d.workstreams.filter((w) => !w.statusOverride);
    const live = active.filter((w) => w.derivedStatus !== 'shipped');
    const liveIds = new Set(live.map((w) => w.id));
    const activeIds = new Set(active.map((w) => w.id));
    for (const r of d.inputRequests) {
        const w = wsById.get(r.workstreamId);
        if (r.state !== 'open' || !w || !activeIds.has(w.id))
            continue;
        const audience = r.assigneeUserId
            ? new Set([r.assigneeUserId])
            : w.accountableUserId
                ? new Set([w.accountableUserId])
                : ownerSide(w);
        items.push({
            id: `input_requested:${r.id}`,
            kind: 'input_requested',
            severity: 'high',
            title: short(r.question),
            detail: `${w.key} · ${w.title} — asked by ${nameOf(r.requestedBy)}`,
            workstreamId: w.id,
            executionId: undefined,
            inputRequestId: r.id,
            since: r.createdAt,
            audience,
        });
    }
    for (const dec of d.decisions) {
        if (dec.status !== 'proposed')
            continue;
        const wss = [dec.originWorkstreamId, ...dec.relatedWorkstreamIds]
            .map((id) => (id ? wsById.get(id) : undefined))
            .filter((w) => !!w && activeIds.has(w.id));
        if (!wss.length)
            continue;
        const audience = new Set();
        for (const w of wss)
            for (const u of relevant(w))
                audience.add(u);
        items.push({
            id: `needs_decision:${dec.id}`,
            kind: 'needs_decision',
            severity: 'high',
            title: `Decide: ${short(dec.title, 120)}`,
            detail: `${dec.key} proposed by ${nameOf(dec.proposedBy)} · ${wss.map((w) => w.key).join(', ')}`,
            workstreamId: wss[0].id,
            decisionId: dec.id,
            since: dec.createdAt,
            audience,
        });
    }
    for (const a of d.artifacts) {
        const w = wsById.get(a.workstreamId);
        if (!w || !liveIds.has(w.id) || !isOpenPr(a))
            continue;
        const label = a.externalId ? `${a.title} (${a.externalId})` : a.title;
        const base = { workstreamId: w.id, artifactId: a.id };
        if (a.review === 'requested')
            items.push({
                ...base,
                id: `review_requested:${a.id}`,
                kind: 'review_requested',
                severity: 'medium',
                title: `Review requested: ${short(a.title, 120)}`,
                detail: `${w.key} · ${label}`,
                since: sinceOf(`review_requested:${a.id}`, a.updatedAt),
                audience: ownerSide(w),
            });
        if (a.ci === 'failing')
            items.push({
                ...base,
                id: `ci_failed:${a.id}`,
                kind: 'ci_failed',
                severity: 'high',
                title: `CI failing: ${short(a.title, 120)}`,
                detail: `${w.key} · ${label}`,
                since: sinceOf(`ci_failed:${a.id}`, a.updatedAt),
                audience: relevant(w),
            });
        if (a.hasConflicts)
            items.push({
                ...base,
                id: `conflict:${a.id}`,
                kind: 'conflict',
                severity: 'medium',
                title: `Merge conflicts: ${short(a.title, 120)}`,
                detail: `${w.key} · ${label}`,
                since: sinceOf(`conflict:${a.id}`, a.updatedAt),
                audience: relevant(w),
            });
        if (a.review === 'approved' && a.ci === 'passing' && !a.hasConflicts)
            items.push({
                ...base,
                id: `ready_to_land:${a.id}`,
                kind: 'ready_to_land',
                severity: 'medium',
                title: `Ready to land: ${short(a.title, 120)}`,
                detail: `${w.key} · ${label} is approved and passing`,
                since: sinceOf(`ready_to_land:${a.id}`, a.updatedAt),
                audience: relevant(w),
            });
    }
    for (const w of live) {
        if (w.derivedStatus !== 'blocked')
            continue;
        const execs = d.executions.filter((e) => e.workstreamId === w.id);
        for (const reason of blockers({ executions: execs, artifacts: [], incomingDependencies: [] })) {
            if (reason.kind !== 'execution_blocked' && reason.kind !== 'execution_failed')
                continue;
            const e = exById.get(reason.executionId);
            items.push({
                id: `blocked:${e.id}`,
                kind: 'blocked',
                severity: 'high',
                title: `${w.key} is blocked: ${short(e.title, 100)}`,
                detail: e.progressNote ? short(e.progressNote, 200) : `Execution ${e.state === 'failed' ? 'failed' : 'is blocked'}`,
                workstreamId: w.id,
                executionId: e.id,
                since: sinceOf(`blocked:${e.id}`, e.updatedAt),
                audience: relevant(w),
            });
        }
    }
    for (const dep of d.dependencies) {
        const target = dep.toType === 'workstream' ? wsById.get(dep.toId) : wsById.get(exById.get(dep.toId)?.workstreamId ?? '');
        const source = dep.fromType === 'workstream' ? wsById.get(dep.fromId) : wsById.get(exById.get(dep.fromId)?.workstreamId ?? '');
        if (!target || !source || target.id === source.id || !liveIds.has(target.id))
            continue;
        if (dep.toType === 'execution' && ['completed', 'failed', 'canceled'].includes(exById.get(dep.toId)?.state ?? ''))
            continue;
        const resolved = dep.fromType === 'workstream' ? source.status === 'shipped' : exById.get(dep.fromId)?.state === 'completed';
        if (resolved || source.ownerTeamId === target.ownerTeamId)
            continue;
        items.push({
            id: `dependency:${dep.id}`,
            kind: 'dependency',
            severity: 'low',
            title: `${target.key} is waiting on ${source.key}`,
            detail: `${source.title} is ${source.status.replace('_', ' ')}`,
            workstreamId: target.id,
            since: dep.createdAt,
            audience: relevant(target),
        });
    }
    for (const w of live) {
        if (!w.targetDate)
            continue;
        const delta = w.targetDate.getTime() - d.now.getTime();
        if (delta > DEADLINE_WINDOW_DAYS * DAY)
            continue;
        const overdue = delta < 0;
        const days = Math.ceil(Math.abs(delta) / DAY);
        items.push({
            id: `deadline:${w.id}`,
            kind: 'deadline',
            severity: overdue ? 'high' : 'medium',
            title: overdue ? `${w.key} is overdue` : `${w.key} is due ${days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}`,
            detail: overdue ? `${w.title} — ${days} day${days === 1 ? '' : 's'} past the target date` : w.title,
            workstreamId: w.id,
            since: w.targetDate,
            audience: relevant(w),
        });
    }
    for (const w of live) {
        if (!w.acceptanceCriteria.length || w.acceptanceCriteria.some((c) => c.state !== 'met'))
            continue;
        const arts = d.artifacts.filter((a) => a.workstreamId === w.id);
        if (arts.some((a) => isPr(a) && (a.state === 'open' || a.state === 'draft')))
            continue;
        if (arts.some((a) => a.kind === 'deployment' || a.kind === 'release'))
            continue;
        items.push({
            id: `ready_to_ship:${w.id}`,
            kind: 'ready_to_ship',
            severity: 'low',
            title: `${w.key} is ready to ship`,
            detail: `${w.title} — all acceptance criteria are met and nothing is deployed yet`,
            workstreamId: w.id,
            since: sinceOf(`ready_to_ship:${w.id}`, w.updatedAt),
            audience: relevant(w),
        });
    }
    const newIntake = d.intake.filter((i) => i.state === 'new');
    const groups = new Map();
    for (const i of newIntake)
        groups.set(i.teamId ?? '', [...(groups.get(i.teamId ?? '') ?? []), i]);
    for (const [teamId, list] of groups) {
        const t = teamId ? teams.get(teamId) : undefined;
        if (teamId && !t)
            continue;
        const since = new Date(Math.max(...list.map((i) => i.createdAt.getTime())));
        const keys = list.slice(0, 3).map((i) => i.key).join(', ');
        items.push({
            id: `triage:${teamId || 'workspace'}`,
            kind: 'triage',
            severity: 'low',
            title: `${list.length} new intake item${list.length === 1 ? '' : 's'} for ${t?.name ?? 'the workspace'}`,
            detail: list.length > 3 ? `${keys} and ${list.length - 3} more` : keys,
            intakeId: list[0].id,
            since,
            audience: new Set(t ? t.memberIds : d.adminIds),
        });
    }
    return items;
}
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
export function sortItems(items) {
    return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.since.getTime() - b.since.getTime() ||
        a.id.localeCompare(b.id));
}
export function itemState(item, row, now) {
    if (!row || row.since.getTime() !== item.since.getTime())
        return { state: 'open' };
    if (row.state === 'dismissed')
        return { state: 'dismissed' };
    if (row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime())
        return { state: 'snoozed', snoozedUntil: row.snoozedUntil };
    return { state: 'open' };
}
//# sourceMappingURL=attention-rules.js.map