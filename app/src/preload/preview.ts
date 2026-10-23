import { contextBridge, ipcRenderer } from 'electron';
// Only the first-party MCP host gets this preload. Its opaque iframe does not inherit this API.
contextBridge.exposeInMainWorld('outputHost', {
  call: (name: string, args: unknown) => ipcRenderer.invoke('outputs:app-call', name, args),
});
