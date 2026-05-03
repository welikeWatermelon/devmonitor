const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devmonitor', {
  // Platform info
  platform: process.platform, // 'win32' | 'darwin' | 'linux'
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
  setProjectPath: (path) => ipcRenderer.invoke('config:set-project-path', path),

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
  unresolveError: (key) => ipcRenderer.send('error:unresolve', key),
  deleteErrors: (keys) => ipcRenderer.send('error:delete', keys),

  // Clipboard copy notification
  onClipboardCopy: (cb) => ipcRenderer.on('clipboard:copy', (_, key) => cb(key)),

  // Deploy history
  getDeployHistory: () => ipcRenderer.invoke('deploy:get-history'),

  // Diagnostics
  diagExec: (serverId, command) => ipcRenderer.invoke('diag:exec', { serverId, command }),

  // Build
  getBuildConfig: () => ipcRenderer.invoke('build:get-config'),
  saveBuildConfig: (cfg) => ipcRenderer.invoke('build:save-config', cfg),
  startBuild: () => ipcRenderer.send('build:start'),
  onBuildLog: (cb) => ipcRenderer.on('build:log', (_, data) => cb(data)),
  onBuildStatus: (cb) => ipcRenderer.on('build:status', (_, status) => cb(status)),

  // Safety
  installDenyRules: () => ipcRenderer.invoke('safety:install-deny-rules'),
  getDenyRulesStatus: () => ipcRenderer.invoke('safety:get-deny-rules-status'),

  // App status
  onAppStatus: (cb) => ipcRenderer.on('app:status', (_, data) => cb(data)),

  // Analysis reports
  getAllReports: () => ipcRenderer.invoke('report:get-all'),
  getReportConfig: () => ipcRenderer.invoke('report:get-config'),
  saveReportConfig: (cfg) => ipcRenderer.invoke('report:save-config', cfg),
  runReportNow: () => ipcRenderer.send('report:run-now'),
  onAutoReportDone: (cb) => ipcRenderer.on('report:auto-done', (_, data) => cb(data)),
  onReportAnalysisUpdated: (cb) => ipcRenderer.on('report:analysis-updated', (_, data) => cb(data)),
  getReportStats: (modifier) => ipcRenderer.invoke('report:get-stats', modifier),
  onStatsRefresh: (cb) => ipcRenderer.on('report:stats-refresh', () => cb())
});
