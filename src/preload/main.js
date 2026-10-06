'use strict';

// The main window's only way to reach the app: a few named calls.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('honeybee', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  connect: (agent, options) => ipcRenderer.invoke('integration:connect', agent, options),
  disconnect: (agent) => ipcRenderer.invoke('integration:disconnect', agent),
  dismiss: (key) => ipcRenderer.invoke('session:dismiss', key),
  setClaudeTerminal: (on) => ipcRenderer.invoke('claude:terminal', on),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  retryServer: () => ipcRenderer.invoke('server:retry'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showFile: (which) => ipcRenderer.invoke('app:show-file', which),
  window: (action) => ipcRenderer.send('window:action', action)
});
