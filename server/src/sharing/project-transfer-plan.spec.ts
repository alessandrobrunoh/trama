import { describe, expect, it } from 'vitest';
import {
  defaultStatusCatalog,
  resolveWorkspaceSettings,
  type MemberAccess,
  type WorkspaceLabel,
  type WorkspaceSettings,
} from '../contracts/domain.js';
import {
  guestRoleFor,
  limitedProjectIds,
  mapStatusValue,
  planTransferMappings,
  TRANSFER_LABEL_CUSTOM_MAX,
} from './project-transfer-plan.js';

const label = (id: string, name: string, extra: Partial<WorkspaceLabel> = {}): WorkspaceLabel => ({
  id,
  name,
  color: '#2563eb',
  template: false,
  scope: 'issue',
  ...extra,
});

const settings = (labels: WorkspaceLabel[] = [], statuses = defaultStatusCatalog()): WorkspaceSettings =>
  resolveWorkspaceSettings({ labels, statuses });

describe('mapStatusValue', () => {
  it('keeps the type and prefers the same name', () => {
    const source = defaultStatusCatalog().issue;
    const target = [
      ...source,
      { id: 'st_doing', name: 'Doing', icon: 'circle-dot', color: '#e2a93b', type: 'in_progress' as const },
    ];
    const same = mapStatusValue(source, target, 'in_progress');
    expect(same?.to.id).toBe('in_progress');
    const renamedSource = source.map((entry) => (entry.type === 'in_progress' ? { ...entry, name: 'Doing' } : entry));
    expect(mapStatusValue(renamedSource, target, 'in_progress')?.to.id).toBe('st_doing');
  });

  it('falls back to the seed of the type when no name matches', () => {
    const source = [{ id: 'st_wip', name: 'WIP', icon: 'circle-dot', color: '#e2a93b', type: 'in_progress' as const }];
    const target = defaultStatusCatalog().issue;
    expect(mapStatusValue(source, target, 'st_wip')?.to).toMatchObject({ id: 'in_progress', type: 'in_progress' });
  });

  it('resolves a legacy enum stored on the record, and ignores values it does not know', () => {
    const catalog = defaultStatusCatalog().issue;
    expect(mapStatusValue(catalog, catalog, 'done')?.to.id).toBe('done');
    expect(mapStatusValue(catalog, catalog, 'nonsense')).toBeNull();
  });
});

describe('planTransferMappings', () => {
  const usage = (labels: [string, number][], issueStatuses: [string, number][] = [['todo', 2]]) => ({
    issueStatuses: new Map(issueStatuses),
    projectStatus: 'in_progress',
    projectHealth: null,
    labels: new Map(labels),
  });
  let n = 0;
  const newId = () => `lb_new${n++}`;

  it('maps labels by name and creates the missing ones', () => {
    const source = settings([label('lb_a', 'Bug'), label('lb_b', 'Urgent fix', { color: '#e11d48' })]);
    const target = settings([label('lb_x', 'bug')]);
    const plan = planTransferMappings(source, target, usage([['lb_a', 3], ['lb_b', 1], ['lb_gone', 1]]), newId);
    expect(plan.labels.get('lb_a')).toBe('lb_x');
    expect(plan.labels.get('lb_gone')).toBeNull();
    expect(plan.newLabels).toHaveLength(1);
    expect(plan.newLabels[0]).toMatchObject({ name: 'Urgent fix', color: '#e11d48', scope: 'issue', template: false });
    expect(plan.labels.get('lb_b')).toBe(plan.newLabels[0].id);
    expect(plan.mappings.filter((row) => row.kind === 'label')).toEqual([
      { kind: 'label', from: 'Bug', to: 'bug', action: 'map', count: 3 },
      { kind: 'label', from: 'Urgent fix', to: 'Urgent fix', action: 'create', count: 1 },
    ]);
  });

  it('keeps the label id when the target does not use it, and issues a new one when it does', () => {
    const source = settings([label('lb_same', 'Alpha'), label('lb_clash', 'Beta')]);
    const target = settings([label('lb_clash', 'Something else')]);
    const plan = planTransferMappings(source, target, usage([['lb_same', 1], ['lb_clash', 1]]), newId);
    expect(plan.labels.get('lb_same')).toBe('lb_same');
    expect(plan.labels.get('lb_clash')).not.toBe('lb_clash');
    expect(plan.newLabels.map((created) => created.name)).toEqual(['Alpha', 'Beta']);
  });

  it('prefers an active label over an archived one of the same name', () => {
    const source = settings([label('lb_a', 'Bug')]);
    const target = settings([label('lb_old', 'Bug', { archived: true }), label('lb_new', 'bug')]);
    expect(planTransferMappings(source, target, usage([['lb_a', 1]]), newId).labels.get('lb_a')).toBe('lb_new');
  });

  it('maps every used status by type and counts what carries it', () => {
    const source = settings();
    const catalog = defaultStatusCatalog();
    const renamed = {
      ...catalog,
      issue: catalog.issue.map((entry) => (entry.type === 'todo' ? { ...entry, name: 'Up next' } : entry)),
    };
    const plan = planTransferMappings(source, settings([], renamed), usage([], [['todo', 2], ['planning', 1]]), newId);
    expect(plan.statuses.issue.get('todo')).toBe('todo');
    expect(plan.statuses.issue.has('planning')).toBe(false);
    expect(plan.mappings.find((row) => row.kind === 'issue')).toMatchObject({ from: 'Planning', to: 'Up next', count: 2 });
    expect(plan.statuses.project.get('in_progress')).toBe('in_progress');
  });

  it('blocks when the target would exceed the label cap', () => {
    const many = Array.from({ length: TRANSFER_LABEL_CUSTOM_MAX }, (_, i) => label(`lb_${i}`, `Label ${i}`));
    const plan = planTransferMappings(settings([label('lb_s', 'Extra')]), settings(many), usage([['lb_s', 1]]), newId);
    expect(plan.blockers).toHaveLength(1);
  });
});

describe('limitedProjectIds', () => {
  const roles = resolveWorkspaceSettings({}).roles;
  const limited = (ids: string[]): MemberAccess => ({
    projects: { all: false, projectIds: ids },
    includeUnassigned: false,
    grants: [],
  });

  it('is null for a person with every project, and for an owner', () => {
    expect(limitedProjectIds(roles, { role: 'member', access: null })).toBeNull();
    expect(limitedProjectIds(roles, { role: 'owner', access: limited(['pj_1']) })).toBeNull();
  });

  it('lists the projects a limited member can see', () => {
    expect(limitedProjectIds(roles, { role: 'viewer', access: limited(['pj_1', 'pj_2']) })).toEqual(['pj_1', 'pj_2']);
  });

  it('is empty for an unknown role, so nothing is shared through it', () => {
    expect(limitedProjectIds(roles, { role: 'ghost', access: limited(['pj_1']) })).toEqual([]);
  });
});

describe('guestRoleFor', () => {
  const roles = resolveWorkspaceSettings({}).roles;

  it('keeps the role the guest had when the target has it and it does not administer', () => {
    expect(guestRoleFor(roles, 'viewer')).toBe('viewer');
    expect(guestRoleFor(roles, 'member')).toBe('member');
  });

  it('never hands out an admin or owner role', () => {
    expect(guestRoleFor(roles, 'admin')).not.toBe('admin');
    expect(guestRoleFor(roles, 'owner')).not.toBe('owner');
  });

  it('is null when nothing fits', () => {
    expect(guestRoleFor(roles.filter((role) => role.owner || role.id === 'admin'), 'viewer')).toBeNull();
  });
});
