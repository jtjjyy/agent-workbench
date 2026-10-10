import { contextBridge, ipcRenderer } from 'electron';
import { validateEventEnvelope, type AgentBridge, type EventEnvelope } from '../shared/contracts';

const bridge: AgentBridge = {
  readConversation: (conversationId) => ipcRenderer.invoke('agent:read-conversation', conversationId),
  submitMessage: (request) => ipcRenderer.invoke('agent:submit-message', request),
  onEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (validateEventEnvelope(payload).ok) listener(payload as EventEnvelope);
    };
    ipcRenderer.on('agent:event', wrapped);
    return () => { ipcRenderer.removeListener('agent:event', wrapped); };
  },
};
contextBridge.exposeInMainWorld('agent', bridge);
