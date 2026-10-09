import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/api';
import type { EngineEvent } from '../shared/types';

const api: Api = {
  onEngineEvent: cb => {
    const handler = (_e: unknown, data: EngineEvent) => cb(data);
    ipcRenderer.on('engine:event', handler);
    return () => ipcRenderer.removeListener('engine:event', handler);
  },
  getState: () => ipcRenderer.invoke('engine:state'),
  getProgress: () => ipcRenderer.invoke('engine:progress'),
  listCourses: () => ipcRenderer.invoke('engine:listCourses'),
  start: (courseIds, resume) => ipcRenderer.invoke('engine:start', courseIds, resume),
  pause: () => ipcRenderer.send('engine:pause'),
  resume: () => ipcRenderer.send('engine:resume'),
  stop: () => ipcRenderer.send('engine:stop'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  getUsername: () => ipcRenderer.invoke('credentials:get'),
  setCredentials: (username, password) => ipcRenderer.invoke('credentials:set', username, password),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getVision: () => ipcRenderer.invoke('vision:get'),
  setVision: key => ipcRenderer.invoke('vision:set', key),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateEvent: cb => {
    const handler = (_e: unknown, info: any) => cb(info?.info ?? info);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },
};

contextBridge.exposeInMainWorld('ch', api);
