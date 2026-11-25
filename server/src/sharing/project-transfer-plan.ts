import {
  LABEL_NAME_MAX,
  STATUS_CATALOG_KEY,
  effectiveMemberAccess,
  findWorkspaceRole,
  resolveLabelCatalog,
  resolveStatusEntry,
  roleHasAdminPower,
  type ID,
  type MemberAccess,
  type ProjectTransferMapping,
  type Role,
  type StatusEntry,
  type StatusSubject,
  type WorkspaceLabel,
  type WorkspaceRole,
  type WorkspaceSettings,
} from '../contracts/domain.js';

/** Same cap `LabelsService` enforces on a workspace. */
export const TRANSFER_LABEL_CUSTOM_MAX = 100;

/** What the project and its issues carry, so the plan only maps what is actually used. */
export interface TransferUsage {
  /** Stored issue status value -> issues that have it. */
  issueStatuses: ReadonlyMap<string, number>;
  projectStatus: string;
  projectHealth: string | null;
  /** Label id -> records (issues and the project) that carry it. */
  labels: ReadonlyMap<string, number>;
}

export interface TransferMappingPlan {
  /** Stored value -> target catalog id, per status subject. A value with no entry is kept as it is. */
  statuses: Record<StatusSubject, Map<string, string>>;
  /** Source label id -> target label id. `null`: the label is not in the source catalog, so it is dropped. */
  labels: Map<string, string | null>;
  /** Labels the target does not have yet. */
  newLabels: WorkspaceLabel[];
  /** For the preview. */
  mappings: ProjectTransferMapping[];
  blockers: string[];
}

/** Same name and type wins, then the same id, then the type's seed, then the first entry of that type. */
export function mapStatusValue<T extends string>(
  source: readonly StatusEntry<T>[],
  target: readonly StatusEntry<T>[],
  stored: string,
): { from: StatusEntry<T>; to: StatusEntry<T> } | null {
  const from = resolveStatusEntry(source, stored);
  if (!from) return null;
  const ofType = target.filter((entry) => entry.type === from.type);
  if (!ofType.length) return null;
  const lower = from.name.toLowerCase();
  const to =
    ofType.find((entry) => entry.name.toLowerCase() === lower) ??
    ofType.find((entry) => entry.id === from.id) ??
    ofType.find((entry) => entry.id === entry.type) ??
    ofType[0];
  return { from, to };
}

function nameOf(name: string): string {
  return name.trim().toLowerCase();
}

export function planTransferMappings(
  source: WorkspaceSettings,
  target: WorkspaceSettings,
  usage: TransferUsage,
  newLabelId: () => string,
): TransferMappingPlan {
  const statuses: TransferMappingPlan['statuses'] = {
    issue: new Map(),
    project: new Map(),
    project_health: new Map(),
  };
  const mappings: ProjectTransferMapping[] = [];
  const blockers: string[] = [];

  const mapSubject = (subject: StatusSubject, values: ReadonlyMap<string, number>) => {
    const key = STATUS_CATALOG_KEY[subject];
    const src = source.statuses[key] as readonly StatusEntry[];
    const dst = target.statuses[key] as readonly StatusEntry[];
    const byTarget = new Map<string, ProjectTransferMapping>();
    for (const [stored, count] of values) {
      const hit = mapStatusValue(src, dst, stored);
      if (!hit) continue;
      statuses[subject].set(stored, hit.to.id);
      const key2 = `${hit.from.id}>${hit.to.id}`;
      const row = byTarget.get(key2);
      if (row) row.count += count;
      else
        byTarget.set(key2, {
          kind: subject,
          from: hit.from.name,
          to: hit.to.name,
          action: 'map',
          count,
        });
    }
    mappings.push(...byTarget.values());
  };
  mapSubject('issue', usage.issueStatuses);
  mapSubject('project', new Map([[usage.projectStatus, 1]]));
  if (usage.projectHealth) mapSubject('project_health', new Map([[usage.projectHealth, 1]]));

  const sourceLabels = new Map(resolveLabelCatalog(source.labels).map((label) => [label.id, label]));
  const targetLabels = resolveLabelCatalog(target.labels);
  const targetByName = new Map<string, WorkspaceLabel>();
  for (const label of targetLabels) {
    const key = nameOf(label.name);
    const known = targetByName.get(key);
    // an active label is the better home than an archived one of the same name
    if (!known || (known.archived && !label.archived)) targetByName.set(key, label);
  }
  const takenIds = new Set(targetLabels.map((label) => label.id));
  const labels = new Map<string, string | null>();
  const newLabels: WorkspaceLabel[] = [];
  for (const [id, count] of usage.labels) {
    const from = sourceLabels.get(id);
    if (!from) {
      labels.set(id, null);
      continue;
    }
    const existing = targetByName.get(nameOf(from.name));
    if (existing) {
      labels.set(id, existing.id);
      mappings.push({ kind: 'label', from: from.name, to: existing.name, action: 'map', count });
      continue;
    }
    const nextId = takenIds.has(from.id) ? newLabelId() : from.id;
    takenIds.add(nextId);
    const created: WorkspaceLabel = {
      id: nextId,
      name: from.name.slice(0, LABEL_NAME_MAX),
      color: from.color,
      template: false,
      scope: from.scope,
      ...(from.archived ? { archived: true as const } : {}),
    };
    newLabels.push(created);
    targetByName.set(nameOf(created.name), created);
    labels.set(id, nextId);
    mappings.push({ kind: 'label', from: from.name, to: created.name, action: 'create', count });
  }
  const customs = targetLabels.filter((label) => !label.template).length;
  if (customs + newLabels.length > TRANSFER_LABEL_CUSTOM_MAX)
    blockers.push(
      `The target workspace would have more than ${TRANSFER_LABEL_CUSTOM_MAX} labels. Remove some of its labels first.`,
    );
  return { statuses, labels, newLabels, mappings, blockers };
}

/** The projects a membership is limited to, or null when it covers every project. Empty: nothing visible. */
export function limitedProjectIds(
  roles: readonly WorkspaceRole[],
  membership: { role: Role; access: MemberAccess | null },
): ID[] | null {
  const role = findWorkspaceRole(roles, membership.role);
  const access = effectiveMemberAccess(role, membership.access);
  if (!access || access.projects.all) return null;
  if (!access.grants.includes('projects:view')) return [];
  return access.projects.projectIds;
}

/**
 * The role a carried-over guest gets in the target: the one they had if the target still has it, else
 * `guest`, `viewer`, `member`. Never an owner or a role that administers the workspace. Null when none fits.
 */
export function guestRoleFor(targetRoles: readonly WorkspaceRole[], sourceRole: Role): Role | null {
  for (const id of [sourceRole, 'guest', 'viewer', 'member']) {
    const role = findWorkspaceRole(targetRoles, id);
    if (role && !role.owner && !roleHasAdminPower(role)) return role.id;
  }
  return null;
}
