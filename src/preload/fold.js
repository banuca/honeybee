'use strict';

// The fold layer's only link to the app: it is told what to play, and says
// when each stage is done.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foldApi', {
  onPlay: (callback) => ipcRenderer.on('fold:play', (_event, plan) => callback(plan)),
  onGo: (callback) => ipcRenderer.on('fold:go', () => callback()),
  onReset: (callback) => ipcRenderer.on('fold:reset', () => callback()),
  onUnfold: (callback) => ipcRenderer.on('unfold:play', (_event, plan) => callback(plan)),
  say: (what) => ipcRenderer.send('fold', what)
});
