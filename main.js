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
  return { servers: [] };
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
      log_path: cfg.log_path || ''
    }];
    // project_path를 최상위로 이전
    if (!cfg.project_path) {
      cfg.project_path = cfg.project_path || '';
    }
    delete cfg.pem_key_path;
    delete cfg.ec2_ip;
    delete cfg.username;
    delete cfg.port;
    delete cfg.log_path;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  }

  // Ensure servers array exists
  if (!cfg.servers) {
    cfg.servers = [];
  }

  // Migrate: servers[].local_path → top-level project_path
  if (!cfg.project_path) {
    const firstWithPath = cfg.servers.find(s => s.local_path);
    cfg.project_path = firstWithPath ? firstWithPath.local_path : '';
  }
  // Remove local_path from all servers
  for (const s of cfg.servers) {
    delete s.local_path;
  }

  // Ensure project_path exists
  if (!cfg.project_path) {
    cfg.project_path = '';
  }

  // Ensure build config exists
  if (!cfg.build) {
    cfg.build = { command: '', work_dir: '', jar_path: '' };
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
  if (server.diag_pem_key_path && !fs.existsSync(server.diag_pem_key_path)) {
    errors.push('진단 PEM 파일이 존재하지 않습니다: ' + server.diag_pem_key_path);
  }
  if (server.ec2_ip && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(server.ec2_ip)) {
    errors.push('EC2 IP 형식이 올바르지 않습니다');
  }
  const port = parseInt(server.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push('포트 번호가 올바르지 않습니다 (1-65535)');
  }
  return errors;
}

// --- Helper: find file recursively ---
function findFileRecursive(dir, fileName) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, build dirs
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target' || entry.name === 'build') continue;
        const found = findFileRecursive(fullPath, fileName);
        if (found) return found;
      } else if (entry.name === fileName) {
        return fullPath;
      }
    }
  } catch (e) {
    // Permission error or deleted dir
  }
  return null;
}

// --- Helper: get VSCode command path ---
function getVSCodeCommand() {
  const vscodePath = 'C:\\Users\\bill5\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code';
  if (process.platform === 'win32' && fs.existsSync(vscodePath)) {
    return vscodePath;
  }
  return 'code';
}

// --- Helper: Claude Code deny rules ---
const DENY_RULES = [
  "Bash(rm:*)",
  "Bash(rm -rf:*)",
  "Bash(sudo:*)",
  "Bash(systemctl stop:*)",
  "Bash(systemctl restart:*)",
  "Bash(scp:*)",
  "Bash(sftp:*)",
  "Bash(ssh:*)",
  "Bash(curl -X POST:*)",
  "Bash(curl -X DELETE:*)",
  "Bash(curl -X PUT:*)"
];

const CLAUDE_SETTINGS_PATH = path.join(__dirname, '.claude', 'settings.local.json');

function installDenyRules() {
  let settings = {};
  try {
    const dir = path.dirname(CLAUDE_SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {
    settings = {};
  }

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];

  // 중복 제거하며 병합
  const existing = new Set(settings.permissions.deny);
  for (const rule of DENY_RULES) {
    existing.add(rule);
  }
  settings.permissions.deny = [...existing];

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  return { success: true, count: settings.permissions.deny.length };
}

function getDenyRulesStatus() {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      const count = (settings.permissions && settings.permissions.deny) ? settings.permissions.deny.length : 0;
      return { installed: count > 0, count };
    }
  } catch (e) {}
  return { installed: false, count: 0 };
}

// --- IPC Handlers ---
function setupIPC() {
  // Config
  ipcMain.handle('config:load', () => config);
  ipcMain.handle('config:save', (_, cfg) => {
    saveConfig(cfg);
    return { success: true };
  });

  // Safety: deny rules
  ipcMain.handle('safety:install-deny-rules', () => installDenyRules());
  ipcMain.handle('safety:get-deny-rules-status', () => getDenyRulesStatus());

  // Build
  ipcMain.handle('build:get-config', () => config.build || {});
  ipcMain.handle('build:save-config', (_, buildCfg) => {
    config.build = buildCfg;
    saveConfig(config);
    return { success: true };
  });
  // Diagnostics exec
  ipcMain.handle('diag:exec', async (_, { serverId, command }) => {
    return new Promise((resolve) => {
      if (!sshManager) return resolve({ output: '연결 없음', error: true });
      sshManager.diagExec(serverId, command, (output, err) => {
        resolve({ output: output || '', error: !!err });
      });
    });
  });

  ipcMain.on('build:start', () => {
    const b = config.build;
    if (!b || !b.command || !b.work_dir) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('build:log', '[DevMonitor] 빌드 설정이 없습니다. 설정에서 빌드 명령을 입력해주세요.\r\n');
      }
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('build:log', `\r\n[DevMonitor] 빌드 시작: ${b.command}\r\n`);
      mainWindow.webContents.send('build:status', 'running');
    }
    const child = require('child_process').spawn(
      'cmd.exe', ['/c', b.command],
      { cwd: b.work_dir, windowsHide: true }
    );
    child.stdout.on('data', (d) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('build:log', d.toString('utf8').replace(/\n/g, '\r\n'));
      }
    });
    child.stderr.on('data', (d) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('build:log', d.toString('utf8').replace(/\n/g, '\r\n'));
      }
    });
    child.on('close', (code) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const msg = code === 0
          ? '\r\n[DevMonitor] \u2705 빌드 성공\r\n'
          : `\r\n[DevMonitor] \u274C 빌드 실패 (exit ${code})\r\n`;
        mainWindow.webContents.send('build:log', msg);
        mainWindow.webContents.send('build:status', code === 0 ? 'success' : 'failed');
      }
    });
  });

  // Project path
  ipcMain.handle('config:set-project-path', (_, projectPath) => {
    if (!config) config = { servers: [], project_path: '' };
    config.project_path = projectPath;
    saveConfig(config);
    return { success: true, project_path: config.project_path };
  });

  // Server CRUD
  ipcMain.handle('server:add', (_, server) => {
    if (!config) config = { servers: [] };
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
    console.log('[Resolve] compositeKey:', compositeKey);

    // 1. errorDetector.groups에서 조회, 없으면 DB에서 조회
    let file = null;
    let line = null;
    let serverId = null;
    let errorKey = null;

    if (errorDetector) {
      const group = errorDetector.groups.get(compositeKey);
      console.log('[Resolve] group from detector:', group);
      if (group) {
        file = group.file;
        line = group.line;
        serverId = group.serverId;
        errorKey = group.errorKey;
      }
    }

    if (!file && errorDB) {
      const row = errorDB.getByCompositeKey(compositeKey);
      console.log('[Resolve] row from DB:', row);
      if (row && row.file_location) {
        const parts = row.file_location.split(':');
        file = parts[0];
        line = parts[1] || '0';
        serverId = row.server_id;
        errorKey = row.error_key;
      }
    }

    // 2. file이 unknown이거나 line이 0이면 VSCode 안 열기
    if (!file || file === 'unknown' || file === 'frontend' || !line || line === '0') {
      console.log('[Resolve] 파일 위치를 특정할 수 없음:', file, line);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:status', {
          type: 'info',
          message: '파일 위치를 특정할 수 없습니다'
        });
      }
    } else {
      // 3. project_path 하위 재귀 탐색 후 VSCode 열기
      const projectPath = config && config.project_path ? config.project_path : '';
      const foundPath = projectPath ? findFileRecursive(projectPath, file) : null;
      console.log('[Resolve] filePath:', foundPath);
      if (foundPath) {
        const codeCmd = getVSCodeCommand();
        const cmd = `"${codeCmd}" -g "${foundPath}:${line}"`;
        console.log('[Resolve] opening VSCode:', cmd);
        require('child_process').exec(cmd, (err) => {
          if (err) console.error('[Resolve] exec error:', err);
        });
      }
    }

    // DB에서 resolved 마킹
    if (errorDB && serverId && errorKey) {
      errorDB.resolve(serverId, errorKey);
    }
  });

  // Error unresolve
  ipcMain.on('error:unresolve', (_, compositeKey) => {
    if (!errorDB) return;
    const parts = compositeKey.split('::');
    if (parts.length === 2) errorDB.unresolve(parts[0], parts[1]);
  });

  // Error delete
  ipcMain.on('error:delete', (_, compositeKeys) => {
    if (!errorDB) return;
    if (compositeKeys === 'ALL') {
      errorDB.deleteAll();
    } else {
      errorDB.deleteMany(compositeKeys);
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

  // PTY (Sector 1) - start with project_path
  const firstServer = config.servers[0];
  const initialPath = config.project_path || null;

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

  // Mode A: clipboard copy + Claude 터미널에 텍스트 입력 (엔터 없음)
  if (currentMode === 'A') {
    const text = group.rawText || `${group.errorType} @ ${group.file}:${group.line}`;
    clipboard.writeText(text);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard:copy', compositeKey);
    }
    const errorPrompt = `다음 서버 에러를 분석하고 수정 방안을 제시해줘 (코드 수정은 하지 마): ${text}`;
    if (ptyManager) {
      ptyManager.injectWithoutEnter(errorPrompt);
    }
  }

  // Mode B: auto-inject into PTY with context switch
  if (currentMode === 'B' && ptyManager && server) {
    const prompt = `다음 서버 에러를 분석하고 코드를 수정해줘: ${group.rawText || group.errorType + ' @ ' + group.file + ':' + group.line}`;
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
