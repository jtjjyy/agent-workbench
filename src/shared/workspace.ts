export interface WorkspaceState {
  root: string | null;
  name: string | null;
  dataEgressConsent: boolean;
}

export type WorkspaceErrorCode = 'RUN_ACTIVE' | 'WORKSPACE_UNAVAILABLE' | 'INVALID_WORKSPACE_COMMAND';
export type WorkspaceResult = { ok: true; workspace: WorkspaceState }
  | { ok: false; code: WorkspaceErrorCode };

export interface SourceEvidence {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  excerpt: string;
}

export type ReadonlyToolName = 'list_files' | 'read_file' | 'search_text';
export type WorkspaceToolName = ReadonlyToolName | 'replace_text' | 'search_knowledge' | 'read_project_knowledge'
  | 'run_powershell' | 'web_search' | 'web_fetch' | 'browser_open' | 'browser_read'
  | 'browser_screenshot' | 'browser_click' | 'browser_type'
  | 'update_task_plan' | 'read_task_state' | 'propose_change_set' | 'run_verification' | 'deliver_changes';
export interface ToolTrace {
  toolCallId: string;
  toolName: WorkspaceToolName | 'unknown';
  summary: string;
}

export type ToolProgress =
  | ({ type: 'started' } & ToolTrace)
  | ({ type: 'completed'; isError: boolean; durationMs: number; sources: SourceEvidence[] } & ToolTrace);

export const EMPTY_WORKSPACE: WorkspaceState = { root: null, name: null, dataEgressConsent: false };
