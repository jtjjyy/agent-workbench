import { isAbsolute } from 'node:path';
import { assertTaskRecord, MAX_TASK_RECORDS, TASK_SCHEMA_VERSION, taskObject } from '../../shared/tasks';
import { isChangeSetJournal } from '../changes/change-set-store';

// Use the task module's record validator, including evidence and approval rules.
export function validateDesktopTaskData(path: string, value: unknown): boolean {
  if (path !== 'tasks/tasks-v1.json') return false;
  try {
    const document = taskObject(value, ['schemaVersion', 'tasks']);
    if (document.schemaVersion !== TASK_SCHEMA_VERSION || !Array.isArray(document.tasks)
      || document.tasks.length > MAX_TASK_RECORDS) return false;
    const tasks = new Set<string>();
    const runs = new Set<string>();
    let active = 0;
    for (const item of document.tasks) {
      assertTaskRecord(item);
      if (tasks.has(item.taskId) || (item.workspaceRoot !== null && !isAbsolute(item.workspaceRoot))) return false;
      tasks.add(item.taskId);
      for (const run of item.runIds) { if (runs.has(run)) return false; runs.add(run); }
      if (item.status === 'running' || item.status === 'waiting_approval') active++;
    }
    return active <= 1;
  } catch { return false; }
}

export function validateDesktopChangeData(path: string, value: unknown): boolean {
  if (path !== 'changes/change-sets.v1.json') return false;
  try { return isChangeSetJournal(value); } catch { return false; }
}
