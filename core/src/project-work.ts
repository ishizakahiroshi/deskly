import type { Project } from './generated/project.js';
import type { WorkItem } from './generated/work_item.js';

/**
 * The pending-work projection from WorkspaceService.projects, using IDs only.
 * Authorization must already have filtered inputs; this is not an access guard.
 * Waiting and on-hold work remain pending, just as in the Python projection.
 */
export function pendingProjectWork(
  project: Readonly<Project>,
  items: readonly Readonly<WorkItem>[],
): readonly Readonly<WorkItem>[] {
  if (project.archived) return [];
  return items
    .filter((item) => item.workspace_id === project.workspace_id
      && item.project_id === project.id && !item.archived && item.state !== '完了')
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** First pending work item by stable ID, matching Python's ORDER BY id. */
export function nextProjectWork(
  project: Readonly<Project>,
  items: readonly Readonly<WorkItem>[],
): Readonly<WorkItem> | undefined {
  return pendingProjectWork(project, items)[0];
}
