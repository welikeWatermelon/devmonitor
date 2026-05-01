const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devmonitor', {
  // PTY (Sector 1)
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_, data) => cb(data)),
  writePty: (data) => ipcRenderer.send('pty:write', data),
  resizePty: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),

  // SSH Log (Sector 2) - now includes serverId
  onSshLogData: (cb) => ipcRenderer.on('ssh-log:data', (_, serverId, data) => cb(serverId, data)),

  // SSH Btop (Sector 3) - now includes serverId
  onSshBtopData: (cb) => ipcRenderer.on('ssh-btop:data', (_, serverId, data) => cb(serverId, data)),
  writeSshBtop: (serverId, data) => ipcRenderer.send('ssh-btop:write', { serverId, data }),
  resizeSshBtop: (serverId, cols, rows) => ipcRenderer.send('ssh-btop:resize', { serverId, cols, rows }),

  // SSH Status - now includes serverId and sector
  onSshStatus: (cb) => ipcRenderer.on('ssh:status', (_, serverId, sector, status) => cb(serverId, sector, status)),

  // Tab switching
  switchTab: (serverId) => ipcRenderer.send('tab:switch', serverId),

  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // Server CRUD
  addServer: (server) => ipcRenderer.invoke('server:add', server),
  updateServer: (server) => ipcRenderer.invoke('server:update', server),
  deleteServer: (serverId) => ipcRenderer.invoke('server:delete', serverId),

  // Servers init event
  onServersInit: (cb) => ipcRenderer.on('servers:init', (_, servers) => cb(servers)),

  // Mode
  setMode: (mode) => ipcRenderer.send('mode:set', mode),

  // Notifications
  toggleNotification: (enabled) => ipcRenderer.send('notification:toggle', enabled),

  // Error events
  onErrorDetected: (cb) => ipcRenderer.on('error:detected', (_, data) => cb(data)),
  onErrorUpdated: (cb) => ipcRenderer.on('error:updated', (_, data) => cb(data)),
  onErrorAnalysis: (cb) => ipcRenderer.on('error:analysis', (_, data) => cb(data)),
  getErrorHistory: () => ipcRenderer.invoke('error:get-history'),
  onErrorHistory: (cb) => ipcRenderer.on('error:history', (_, data) => cb(data)),
  resolveError: (key) => ipcRenderer.send('error:resolve', key),

  // Clipboard copy notification
  onClipboardCopy: (cb) => ipcRenderer.on('clipboard:copy', (_, key) => cb(key)),

  // App status
  onAppStatus: (cb) => ipcRenderer.on('app:status', (_, data) => cb(data))
});
