'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onFlash: (callback) => ipcRenderer.on('flash', (_event, kind) => callback(kind)),
  pointer: (phase) => ipcRenderer.send('bubble:pointer', phase),
  menu: () => ipcRenderer.send('bubble:menu')
});
