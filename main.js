const { app, BrowserWindow, ipcMain, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Modules (loaded after app ready)
let ptyManager = null;
let sshManager = null;
let errorDB = null;
let errorDetector = null;
let mainWindow = null;

// App state
let currentMode = 'A';
let notificationsEnabled = true;
let config = null;
let activeTabServerId = null;

const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Windows version check ---
function checkWindowsVersion() {
  if (process.platform === 'win32') {
    const release = os.release().split('.');
    const build = parseInt(release[2], 10);
    if (build < 17763) {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'Windows 버전 미지원',
        'DevMonitor는 Windows 10 1809 (빌드 17763) 이상이 필요합니다.\n현재 빌드: ' + build
      );
      app.quit();
      return false;
    }
  }
  return true;
}

// --- Config ---
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      let cfg = JSON.parse(raw);
      cfg = migrateConfig(cfg);
      return cfg;
    }
  } catch (e) {
    console.error('Config load error:', e.message);
  }
  return null;
}

function migrateConfig(cfg) {
  // Migrate old single-server format to servers array
  if (cfg.ec2_ip && !cfg.servers) {
    cfg.servers = [{
      id: 'server1',
      name: '서버 1',
      pem_key_path: cfg.pem_key_path || '',
      ec2_ip: cfg.ec2_ip,
      username: cfg.username || 'ec2-user',
      port: cfg.port || 22,
      log_path: cfg.log_path || '',
      local_path: cfg.project_path || ''
    }];
    delete cfg.pem_key_path;
    delete cfg.ec2_ip;
    delete cfg.username;
    delete cfg.port;
    delete cfg.log_path;
    delete cfg.project_path;
    // Save migrated config
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  }

  // Ensure servers array exists
  if (!cfg.servers) {
    cfg.servers = [];
  }

  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  config = cfg;
}

function validateServer(server) {
  const errors = [];
  if (!server.id || !/^[a-z0-9-]+$/.test(server.id)) {
    errors.push('ID는 영문 소문자, 숫자, 하이픈만 허용됩니다');
  }
  if (!server.name) {
    errors.push('서버 이름은 필수입니다');
  }
  if (server.pem_key_path && !fs.existsSync(server.pem_key_path)) {
    errors.push('PEM 파일이 존재하지 않습니다: ' + server.pem_key_path);
  }
  if (server.ec2_ip && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(server.ec2_ip)) {
    errors.push('EC2 IP 형식이 올바르지 않습니다');
  }
  if (server.local_path && !fs.existsSync(server.local_path)) {
    errors.push('로컬 경로가 존재하지 않습니다: ' + server.local_path);
  }
  const port = parseInt(server.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push('포트 번호가 올바르지 않습니다 (1-65535)');
  }
  return errors;
}

// --- IPC Handlers ---
function setupIPC() {
  // Config
  ipcMain.handle('config:load', () => config);
  ipcMain.handle('config:save', (_, cfg) => {
    saveConfig(cfg);
    return { success: true };
  });

  // Server CRUD
  ipcMain.handle('server:add', (_, server) => {
    const errors = validateServer(server);
    if (errors.length > 0) return { success: false, errors };

    // Check duplicate ID
    if (config.servers.some(s => s.id === server.id)) {
      return { success: false, errors: ['이미 존재하는 서버 ID입니다: ' + server.id] };
    }

    config.servers.push(server);
    saveConfig(config);

    // Connect the new server
    connectSingleServer(server);

    return { success: true, servers: config.servers };
  });

  ipcMain.handle('server:update', (_, server) => {
    const errors = validateServer(server);
    if (errors.length > 0) return { success: false, errors };

    const idx = config.servers.findIndex(s => s.id === server.id);
    if (idx === -1) return { success: false, errors: ['서버를 찾을 수 없습니다'] };

    config.servers[idx] = server;
    saveConfig(config);

    // Reconnect the updated server
    if (sshManager) {
      sshManager.disconnectServer(server.id);
      connectSingleServer(server);
    }

    return { success: true, servers: config.servers };
  });

  ipcMain.handle('server:delete', (_, serverId) => {
    // Disconnect SSH first
    if (sshManager) {
      sshManager.disconnectServer(serverId);
    }

    config.servers = config.servers.filter(s => s.id !== serverId);
    saveConfig(config);

    return { success: true, servers: config.servers };
  });

  // Tab switch
  ipcMain.on('tab:switch', (_, serverId) => {
    activeTabServerId = serverId;
  });

  // Mode
  ipcMain.on('mode:set', (_, mode) => {
    currentMode = mode;
  });

  // Notification toggle
  ipcMain.on('notification:toggle', (_, enabled) => {
    notificationsEnabled = enabled;
  });

  // PTY
  ipcMain.on('pty:write', (_, data) => {
    if (ptyManager) ptyManager.write(data);
  });
  ipcMain.on('pty:resize', (_, { cols, rows }) => {
    if (ptyManager) ptyManager.resize(cols, rows);
  });

  // SSH btop input - now with serverId
  ipcMain.on('ssh-btop:write', (_, { serverId, data }) => {
    if (sshManager) sshManager.writeBtop(serverId, data);
  });
  ipcMain.on('ssh-btop:resize', (_, { serverId, cols, rows }) => {
    if (sshManager) sshManager.resizeBtop(serverId, cols, rows);
  });

  // Error resolve - compositeKey is "serverId::errorKey"
  ipcMain.on('error:resolve', (_, compositeKey) => {
    if (errorDetector) {
      const group = errorDetector.groups.get(compositeKey);
      if (group && group.file && group.line) {
        require('child_process').exec(`code "${group.file}:${group.line}"`);
      }
      if (errorDB && group) {
        errorDB.resolve(group.serverId, group.errorKey);
      }
    }
  });

  // Error history
  ipcMain.handle('error:get-history', () => {
    if (errorDB) return errorDB.getAll();
    return [];
  });
}

// --- SSH connection helpers ---
function connectSingleServer(server) {
  if (!sshManager) return;

  sshManager.connectServer(
    server,
    // onLogData
    (serverId, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ssh-log:data', serverId, data);
      }
      // Feed to error detector - always, regardless of active tab
      if (errorDetector) {
        const srv = config.servers.find(s => s.id === serverId);
        const serverName = srv ? srv.name : serverId;
        data.split('\n').filter(Boolean).forEach(line => {
          errorDetector.processLine(line, serverId, serverName);
        });
      }
    },
    // onBtopData
    (serverId, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ssh-btop:data', serverId, data);
      }
    },
    // onStatus
    (serverId, sector, status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ssh:status', serverId, sector, status);
      }
    }
  );
}

// --- Initialize all connections ---
function initializeConnections() {
  if (!config || !config.servers || config.servers.length === 0) return;

  // PTY (Sector 1) - start with first server's local_path
  const firstServer = config.servers[0];
  const initialPath = firstServer.local_path || null;

  try {
    const PtyManager = require('./pty');
    if (ptyManager) ptyManager.dispose();
    ptyManager = new PtyManager();
    ptyManager.activeClaudeServerId = firstServer.id;
    ptyManager.start(initialPath, (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', data);
      }
    });

    ptyManager.setAnalysisCallback((errorKey, analysis) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('error:analysis', { key: errorKey, analysis });
      }
      // Parse compositeKey to get serverId and errorKey for DB
      if (errorDB) {
        const parts = errorKey.split('::');
        if (parts.length === 2) {
          errorDB.updateAnalysis(parts[0], parts[1], analysis);
        }
      }
    });
  } catch (e) {
    console.error('node-pty 로드 실패:', e.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:status', {
        type: 'error',
        message: 'node-pty를 로드할 수 없습니다. npm rebuild를 실행해주세요.'
      });
    }
  }

  // SSH (Sectors 2 & 3) - connect all servers
  try {
    const SSHManager = require('./ssh');
    if (sshManager) sshManager.dispose();
    sshManager = new SSHManager();

    for (const server of config.servers) {
      connectSingleServer(server);
    }
  } catch (e) {
    console.error('SSH 모듈 로드 실패:', e.message);
  }
}

// --- Error handling callbacks ---
function onNewError(compositeKey, group) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('error:detected', { key: compositeKey, group });
  }

  // Save to DB
  if (errorDB) {
    errorDB.upsert(
      group.serverId,
      group.serverName,
      group.errorKey,
      group.errorType,
      group.file ? `${group.file}:${group.line}` : null
    );
  }

  // Find the server for this error
  const server = config ? config.servers.find(s => s.id === group.serverId) : null;

  // Mode A: clipboard copy
  if (currentMode === 'A') {
    const text = group.rawText || `${group.errorType} @ ${group.file}:${group.line}`;
    clipboard.writeText(text);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard:copy', compositeKey);
    }
  }

  // Mode B: auto-inject into PTY with context switch
  if (currentMode === 'B' && ptyManager && server) {
    const prompt = `다음 서버 에러를 분석하고 수정 방안을 제시해줘 (코드 수정은 하지 마): ${group.rawText || group.errorType + ' @ ' + group.file + ':' + group.line}`;
    ptyManager.switchContext(server, prompt, compositeKey);
  }

  // Notification
  if (notificationsEnabled && Notification.isSupported()) {
    new Notification({
      title: `DevMonitor - ${group.serverName || '에러 감지'}`,
      body: `${group.errorType} @ ${group.file}:${group.line}`
    }).show();
  }
}

function onUpdateError(compositeKey, group) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('error:updated', { key: compositeKey, group });
  }
  if (errorDB) {
    errorDB.updateCount(group.serverId, group.errorKey);
  }
}

function onFloodWarning() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', {
      type: 'warning',
      message: '에러 폭증이 감지되었습니다. 일부 에러가 드롭됩니다.'
    });
  }
}

// --- App lifecycle ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'DevMonitor',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  if (!checkWindowsVersion()) return;

  setupIPC();
  createWindow();

  // Load config (with auto-migration)
  config = loadConfig();

  // Initialize error detector
  try {
    const ErrorDetector = require('./errorDetector');
    errorDetector = new ErrorDetector(onNewError, onUpdateError, onFloodWarning);
  } catch (e) {
    console.error('ErrorDetector 로드 실패:', e.message);
  }

  // Initialize DB
  try {
    const ErrorDB = require('./db');
    errorDB = new ErrorDB();
  } catch (e) {
    console.error('DB 초기화 실패:', e.message);
  }

  // If config exists and has servers, start connections
  if (config && config.servers && config.servers.length > 0) {
    activeTabServerId = config.servers[0].id;
    initializeConnections();
  }

  // Notify renderer when ready
  mainWindow.webContents.on('did-finish-load', () => {
    if (!config || !config.servers || config.servers.length === 0) {
      mainWindow.webContents.send('app:status', {
        type: 'info',
        message: 'config-missing'
      });
    }

    // Send servers list to renderer
    if (config && config.servers) {
      mainWindow.webContents.send('servers:init', config.servers);
    }

    // Send error history
    if (errorDB) {
      const history = errorDB.getAll();
      mainWindow.webContents.send('error:history', history);
    }
  });
});

app.on('window-all-closed', () => {
  if (ptyManager) ptyManager.dispose();
  if (sshManager) sshManager.dispose();
  if (errorDB) errorDB.close();
  app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
