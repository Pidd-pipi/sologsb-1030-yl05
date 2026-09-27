import type { ChecklistItem, ChecklistProject, ChecklistRevision, DiffEntry, VersionOption } from './types';

/** 冻结快照按修订号倒序排列（不依赖数组顺序）。 */
export function frozenRevisions(project: ChecklistProject): ChecklistRevision[] {
  return project.revisions.filter((revision) => revision.status === 'frozen').sort((a, b) => b.revision - a.revision);
}

export function latestFrozenRevision(project: ChecklistProject): ChecklistRevision | undefined {
  return frozenRevisions(project)[0];
}

export function findRevision(project: ChecklistProject, revisionId: string): ChecklistRevision | undefined {
  return project.revisions.find((revision) => revision.id === revisionId);
}

export type RestoreEligibility =
  | { ok: true; source: ChecklistRevision }
  | { ok: false; reason: string; hint?: string };

/**
 * “从冻结版本创建修订”准入规则：
 * 仅编辑中草稿、且所选快照为最新冻结版本时允许；旧快照被阻止并指出最新版本。
 */
export function checkRestoreEligibility(project: ChecklistProject, sourceId: string): RestoreEligibility {
  const latest = latestFrozenRevision(project);
  if (project.status === 'frozen' && latest) {
    return { ok: false, reason: `当前 r${project.revision} 已是冻结状态，请使用“创建修订 r${project.revision + 1}”继续修改。` };
  }
  if (project.status === 'review') {
    return { ok: false, reason: '当前版本正在复核中，复核结束后才能创建新修订。' };
  }
  if (!latest) {
    return { ok: false, reason: '还没有冻结版本，可直接在当前草稿上继续编辑。' };
  }
  const source = project.revisions.find((revision) => revision.id === sourceId);
  if (!source || source.status !== 'frozen') {
    return { ok: false, reason: '请先选择一个冻结版本作为修订来源。' };
  }
  if (source.id !== latest.id) {
    return {
      ok: false,
      reason: `r${source.revision} 后面已经有修订（最新冻结版本为 r${latest.revision}），不能从该版本创建修订。`,
      hint: '请选择最新冻结版本，以避免把后续改动带回新版本。'
    };
  }
  return { ok: true, source };
}

const itemLabel = (item: ChecklistItem) => `${item.challenge || '未命名'} → ${item.response || '未填写'}`;

export function buildVersionOptions(project: ChecklistProject): VersionOption[] {
  return [
    { id: 'current', label: `当前 r${project.revision} · ${statusLabel(project.status)}` },
    ...project.revisions.map((revision) => ({ id: revision.id, label: `r${revision.revision} · ${statusLabel(revision.status)} · ${new Date(revision.createdAt).toLocaleDateString('zh-CN')}` }))
  ];
}

export function diffVersions(project: ChecklistProject, leftId: string, rightId: string): DiffEntry[] {
  const left = versionProject(project, leftId);
  const right = versionProject(project, rightId);
  if (!left || !right) return [];
  const entries: DiffEntry[] = [];
  const oldItems = new Map(left.items.map((item) => [item.id, item]));
  const newItems = new Map(right.items.map((item) => [item.id, item]));
  const allIds = new Set([...oldItems.keys(), ...newItems.keys()]);

  for (const id of allIds) {
    const before = oldItems.get(id);
    const after = newItems.get(id);
    const stageName = (item?: ChecklistItem) => project.stages.find((stage) => stage.id === item?.stageId)?.name ?? '未分配阶段';
    if (!before && after) {
      entries.push({ type: 'added', key: id, stage: stageName(after), before: '—', after: itemLabel(after) });
    } else if (before && !after) {
      entries.push({ type: 'removed', key: id, stage: stageName(before), before: itemLabel(before), after: '—' });
    } else if (before && after && JSON.stringify({ ...before, updatedAt: '' }) !== JSON.stringify({ ...after, updatedAt: '' })) {
      entries.push({
        type: 'changed',
        key: id,
        stage: stageName(after),
        before: `${itemLabel(before)}${before.critical ? ' [关键]' : ''}`,
        after: `${itemLabel(after)}${after.critical ? ' [关键]' : ''}`
      });
    }
  }

  const oldStageIds = new Set(left.stages.map((stage) => stage.id));
  const newStageIds = new Set(right.stages.map((stage) => stage.id));
  right.stages.filter((stage) => !oldStageIds.has(stage.id)).forEach((stage) => {
    entries.push({ type: 'stage', key: stage.id, stage: stage.name, before: '—', after: `新增阶段：${stage.description || stage.name}` });
  });
  left.stages.filter((stage) => !newStageIds.has(stage.id)).forEach((stage) => {
    entries.push({ type: 'stage', key: stage.id, stage: stage.name, before: `移除阶段：${stage.description || stage.name}`, after: '—' });
  });

  const stageOrderChanged = left.stages.map((stage) => stage.id).join('|') !== right.stages.map((stage) => stage.id).join('|');
  if (stageOrderChanged) {
    entries.unshift({
      type: 'stage',
      key: 'stage-order',
      stage: '阶段排序',
      before: left.stages.sort((a, b) => a.order - b.order).map((stage) => stage.name).join(' → '),
      after: right.stages.sort((a, b) => a.order - b.order).map((stage) => stage.name).join(' → ')
    });
  }
  return entries;
}

function versionProject(project: ChecklistProject, id: string): Pick<ChecklistProject, 'stages' | 'items'> | undefined {
  if (id === 'current') return { stages: project.stages, items: project.items };
  const revision: ChecklistRevision | undefined = project.revisions.find((entry) => entry.id === id);
  return revision ? { stages: revision.stages, items: revision.items } : undefined;
}

function statusLabel(status: ChecklistProject['status']): string {
  return { draft: '编辑中', review: '复核中', frozen: '已冻结' }[status];
}
