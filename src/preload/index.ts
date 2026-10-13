import { contextBridge, ipcRenderer } from 'electron';
import { validateEventEnvelope, type AgentBridge, type EventEnvelope } from '../shared/contracts';

const bridge: AgentBridge = {
  readTasks: () => ipcRenderer.invoke('agent:read-tasks'),
  pauseTask: (request) => ipcRenderer.invoke('agent:pause-task', request),
  cancelTask: (request) => ipcRenderer.invoke('agent:cancel-task', request),
  resumeTask: (request) => ipcRenderer.invoke('agent:resume-task', request),
  readPendingChangeSet: () => ipcRenderer.invoke('agent:read-pending-change-set'),
  decideChangeSet: (request) => ipcRenderer.invoke('agent:decide-change-set', request),
  readChangeSets: (taskId) => ipcRenderer.invoke('agent:read-change-sets', taskId),
  getDelivery: (taskId) => ipcRenderer.invoke('agent:read-delivery', taskId),
  readDesktopInfo: () => ipcRenderer.invoke('agent:read-desktop-info'),
  completeSetup: () => ipcRenderer.invoke('agent:complete-setup'),
  exportDiagnostics: () => ipcRenderer.invoke('agent:export-diagnostics'),
  backupDesktop: (request) => ipcRenderer.invoke('agent:backup-desktop', request),
  restoreDesktop: () => ipcRenderer.invoke('agent:restore-desktop'),
  readConversation: (conversationId) => ipcRenderer.invoke('agent:read-conversation', conversationId),
  submitMessage: (request) => ipcRenderer.invoke('agent:submit-message', request),
  readModelSettings: () => ipcRenderer.invoke('agent:read-model-settings'),
  saveModelSettings: (request) => ipcRenderer.invoke('agent:save-model-settings', request),
  deleteModelApiKey: () => ipcRenderer.invoke('agent:delete-model-api-key'),
  cancelRun: (request) => ipcRenderer.invoke('agent:cancel-run', request),
  readWorkspace: () => ipcRenderer.invoke('agent:read-workspace'),
  chooseWorkspace: () => ipcRenderer.invoke('agent:choose-workspace'),
  setWorkspaceConsent: (request) => ipcRenderer.invoke('agent:set-workspace-consent', request),
  clearWorkspace: () => ipcRenderer.invoke('agent:clear-workspace'),
  readPendingFileEdit: () => ipcRenderer.invoke('agent:read-pending-file-edit'),
  decideFileEdit: (request) => ipcRenderer.invoke('agent:decide-file-edit', request),
  readPendingCommand: () => ipcRenderer.invoke('agent:read-pending-command'),
  decideCommand: (request) => ipcRenderer.invoke('agent:decide-command', request),
  readKnowledgeState: () => ipcRenderer.invoke('agent:read-knowledge-state'),
  syncKnowledge: () => ipcRenderer.invoke('agent:sync-knowledge'),
  searchKnowledge: (request) => ipcRenderer.invoke('agent:search-knowledge', request),
  readProjectKnowledge: () => ipcRenderer.invoke('agent:read-project-knowledge'),
  readMemories: () => ipcRenderer.invoke('agent:read-memories'),
  saveMemory: (request) => ipcRenderer.invoke('agent:save-memory', request),
  deleteMemory: (request) => ipcRenderer.invoke('agent:delete-memory', request),
  readSkills: () => ipcRenderer.invoke('agent:read-skills'),
  setSkillEnabled: (request) => ipcRenderer.invoke('agent:set-skill-enabled', request),
  onEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (validateEventEnvelope(payload).ok) listener(payload as EventEnvelope);
    };
    ipcRenderer.on('agent:event', wrapped);
    return () => { ipcRenderer.removeListener('agent:event', wrapped); };
  },
};
contextBridge.exposeInMainWorld('agent', bridge);
