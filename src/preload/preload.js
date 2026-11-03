'use strict';
// Schmale Brücke zur Oberfläche: nur benannte Aufrufe, keine freien IPC-Kanäle.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (ch, arg) => {
  const r = await ipcRenderer.invoke(ch, arg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const listen = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.off(ch, h);
};

contextBridge.exposeInMainWorld('cable', {
  platform: process.platform,
  getStore: () => invoke('store:get'),
  saveSession: (s) => invoke('session:save', s),
  hasPassword: (id) => invoke('session:has-password', { id }),
  saveGroup: (g) => invoke('group:save', g),
  deleteGroup: (id) => invoke('group:delete', { id }),
  setLogging: (tabId, on) => invoke('log:set', { tabId, on }),
  revealLog: (file) => invoke('log:reveal', { file }),
  exportText: (name, text) => invoke('export:text', { name, text }),
  tftpStatus: () => invoke('tftp:status'),
  tftpStart: (cfg) => invoke('tftp:start', cfg),
  tftpStop: () => invoke('tftp:stop'),
  tftpPick: () => invoke('tftp:pick'),
  tftpReveal: () => invoke('tftp:reveal'),
  scpStatus: () => invoke('scp:status'),
  scpStart: (cfg) => invoke('scp:start', cfg),
  scpStop: () => invoke('scp:stop'),
  scpCopy: (job) => invoke('scp:copy', job),
  scpCancel: () => invoke('scp:cancel'),
  scpPick: () => invoke('scp:pick'),
  scpPickFile: () => invoke('scp:pick-file'),
  scpPickSave: (name) => invoke('scp:pick-save', { name }),
  scpReveal: () => invoke('scp:reveal'),
  deleteSession: (id) => invoke('session:delete', { id }),
  forgetPassword: (id) => invoke('session:forget-password', { id }),
  saveSnippets: (items) => invoke('snippets:save', { items }),
  saveRules: (items) => invoke('rules:save', { items }),
  saveSettings: (v) => invoke('settings:save', v),
  serialPorts: () => invoke('serial:list'),
  parseQuick: (text) => invoke('quick:parse', { text }),
  importSshConfig: () => invoke('import:sshconfig'),
  importPutty: () => invoke('import:putty'),
  importStaging: () => invoke('staging:import'),
  removeStaging: () => invoke('staging:remove'),
  pickKey: () => invoke('key:pick'),
  hostKeys: () => invoke('hostkeys:list'),
  forgetHostKey: (host, port) => invoke('hostkeys:forget', { host, port }),
  openLogs: () => invoke('logs:open'),
  open: (tabId, session, cols, rows, extra = {}) => invoke('conn:open', { tabId, session, cols, rows, password: extra.password, trustNew: extra.trustNew }),
  close: (tabId) => invoke('conn:close', { tabId }),
  sendBreak: (tabId) => invoke('conn:break', { tabId }),
  addForward: (tabId, forward) => invoke('conn:forward', { tabId, forward }),
  write: (tabId, data) => ipcRenderer.send('conn:write', { tabId, data }),
  resize: (tabId, cols, rows) => ipcRenderer.send('conn:resize', { tabId, cols, rows }),
  reply: (id, value) => ipcRenderer.send('ask:reply', { id, value }),
  ready: () => ipcRenderer.send('ui:ready'),
  onData: listen('conn:data'),
  onState: listen('conn:state'),
  onAsk: listen('ask:request'),
  onMenu: listen('menu'),
  onDraft: listen('open:draft'),
  onOpenSession: listen('open:session'),
  onTftp: listen('tftp:event'),
  onScp: listen('scp:event'),
  onScpProgress: listen('scp:progress'),
});
