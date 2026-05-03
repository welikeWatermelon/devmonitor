const { app, BrowserWindow, ipcMain, clipboard, Notification, Menu } = require('electron');
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
    if (!cfg.project_path) cfg.project_path = '';
    delete cfg.pem_key_path;
    delete cfg.ec2_ip;
    delete cfg.username;
    delete cfg.port;
    delete cfg.log_path;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  }
  if (!cfg.servers) cfg.servers = [];
  if (!cfg.project_path) {
    const firstWithPath = cfg.servers.find(s => s.local_path);
    cfg.project_path = firstWithPath ? firstWithPath.local_path : '';
  }
  for (const s of cfg.servers) delete s.local_path;
  if (!cfg.project_path) cfg.project_path = '';

  if (!cfg.build) cfg.build = {};
  cfg.build.os = cfg.build.os || 'windows';
  cfg.build.deploy_mode = cfg.build.deploy_mode || 'direct';
  cfg.build.command = cfg.build.command || '';
  cfg.build.work_dir = cfg.build.work_dir || '';
  cfg.build.jar_path = cfg.build.jar_path || '';
  cfg.build.deploy_server_id = cfg.build.deploy_server_id || '';
  cfg.build.ec2_restart_cmd = cfg.build.ec2_restart_cmd || '';
  cfg.build.git_work_dir = cfg.build.git_work_dir || '';

  if (!cfg.auto_report) cfg.auto_report = {};
  cfg.auto_report.enabled = cfg.auto_report.enabled !== undefined ? cfg.auto_report.enabled : false;
  cfg.auto_report.interval_hours = cfg.auto_report.interval_hours || 24;

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
  if (!server.name) errors.push('서버 이름은 필수입니다');
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
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target' || entry.name === 'build') continue;
        const found = findFileRecursive(fullPath, fileName);
        if (found) return found;
      } else if (entry.name === fileName) {
        return fullPath;
      }
    }
  } catch (e) {}
  return null;
}

// --- Helper: get VSCode command path ---
function getVSCodeCommand() {
  if (process.platform === 'darwin') {
    // Mac: 일반적인 VS Code 설치 경로
    const macPath = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    if (fs.existsSync(macPath)) return macPath;
    return 'code'; // PATH에 code가 등록된 경우
  }
  if (process.platform === 'win32') {
    // Windows: 사용자별 설치 경로 순서대로 탐색
    const candidates = [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code'),
      'C:\\Program Files\\Microsoft VS Code\\bin\\code',
      'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return 'code'; // PATH fallback
}

// --- Helper: Claude Code deny rules ---
const DENY_RULES = [
  "Bash(rm:*)", "Bash(rm -rf:*)", "Bash(sudo:*)",
  "Bash(systemctl stop:*)", "Bash(systemctl restart:*)",
  "Bash(scp:*)", "Bash(sftp:*)", "Bash(ssh:*)",
  "Bash(curl -X POST:*)", "Bash(curl -X DELETE:*)", "Bash(curl -X PUT:*)"
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
  } catch (e) { settings = {}; }
  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];
  const existing = new Set(settings.permissions.deny);
  for (const rule of DENY_RULES) existing.add(rule);
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

// --- Auto Analysis Report ---
let autoReportTimer = null;

function runAutoReport() {
  // 통계 대시보드 방식으로 전환 — Claude Code 분석 없이 새로고침 이벤트만 브로드캐스트
  const { BrowserWindow: _BW } = require('electron');
  for (const win of _BW.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('report:stats-refresh');
  }
}

function resetAutoReportTimer() {
  if (autoReportTimer) { clearInterval(autoReportTimer); autoReportTimer = null; }
  if (config && config.auto_report && config.auto_report.enabled) {
    const intervalMs = ((config.auto_report.interval_hours) || 24) * 3600 * 1000;
    autoReportTimer = setInterval(runAutoReport, intervalMs);
  }
}

// --- IPC Handlers ---
function setupIPC() {
  ipcMain.handle('config:load', () => config);
  ipcMain.handle('config:save', (_, cfg) => { saveConfig(cfg); return { success: true }; });

  ipcMain.handle('safety:install-deny-rules', () => installDenyRules());
  ipcMain.handle('safety:get-deny-rules-status', () => getDenyRulesStatus());

  ipcMain.handle('build:get-config', () => config.build || {});
  ipcMain.handle('build:save-config', (_, buildCfg) => {
    config.build = buildCfg;
    saveConfig(config);
    return { success: true };
  });

  ipcMain.handle('diag:exec', async (_, { serverId, command }) => {
    return new Promise((resolve) => {
      if (!sshManager) return resolve({ output: '연결 없음', error: true });
      sshManager.diagExec(serverId, command, (output, err) => {
        resolve({ output: output || '', error: !!err });
      });
    });
  });

  ipcMain.on('build:start', async () => {
    const b = config.build;
    let buildLog = '';
    const send = (event, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, data);
    };
    const log = (msg) => { buildLog += msg; send('build:log', msg); };
    const saveDeploy = (status) => {
      if (errorDB) {
        const server = config.servers.find(s => s.id === b.deploy_server_id);
        errorDB.insertDeploy(
          b.deploy_server_id || 'N/A',
          server ? server.name : 'N/A',
          b.deploy_mode || 'direct',
          b.os || 'windows',
          status,
          buildLog
        );
      }
    };

    if (!b.command || !b.work_dir) {
      log('[DevMonitor] 빌드 설정이 없습니다.\r\n');
      return;
    }

    const isWin = b.os !== 'mac';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const shellArgs = (cmd) => isWin ? ['/c', cmd] : ['-c', cmd];

    log(`\r\n[DevMonitor] 빌드 시작 (${isWin ? 'Windows' : 'Mac'}): ${b.command}\r\n`);
    send('build:status', 'running');

    const buildResult = await new Promise((resolve) => {
      const child = require('child_process').spawn(shell, shellArgs(b.command), {
        cwd: b.work_dir, windowsHide: true
      });
      child.stdout.on('data', d => log(d.toString('utf8').replace(/\n/g, '\r\n')));
      child.stderr.on('data', d => log(d.toString('utf8').replace(/\n/g, '\r\n')));
      child.on('close', code => resolve(code));
    });

    if (buildResult !== 0) {
      log(`\r\n[DevMonitor] ❌ 빌드 실패 (exit ${buildResult})\r\n`);
      send('build:status', 'failed');
      saveDeploy('failed');
      return;
    }
    log('\r\n[DevMonitor] ✅ 빌드 성공\r\n');

    if (b.deploy_mode === 'github') {
      const gitDir = b.git_work_dir || b.work_dir;
      log('\r\n[DevMonitor] 🚀 GitHub Actions 배포: git push 실행\r\n');
      const gitResult = await new Promise((resolve) => {
        const child = require('child_process').spawn(shell, shellArgs('git push'), {
          cwd: gitDir, windowsHide: true
        });
        child.stdout.on('data', d => log(d.toString('utf8').replace(/\n/g, '\r\n')));
        child.stderr.on('data', d => log(d.toString('utf8').replace(/\n/g, '\r\n')));
        child.on('close', code => resolve(code));
      });
      if (gitResult === 0) {
        log('\r\n[DevMonitor] ✅ git push 완료 — GitHub Actions 진행 중\r\n');
        send('build:status', 'success');
        saveDeploy('success');
      } else {
        log('\r\n[DevMonitor] ❌ git push 실패\r\n');
        send('build:status', 'failed');
        saveDeploy('failed');
      }
    } else {
      // 직접 전송: SFTP + EC2 재시작
      const server = config.servers.find(s => s.id === b.deploy_server_id);
      if (!server) {
        log('\r\n[DevMonitor] ❌ 배포 대상 서버를 찾을 수 없습니다.\r\n');
        send('build:status', 'failed');
        saveDeploy('failed');
        return;
      }
      if (!b.jar_path) {
        log('\r\n[DevMonitor] ❌ jar 경로가 설정되지 않았습니다.\r\n');
        send('build:status', 'failed');
        saveDeploy('failed');
        return;
      }

      const remoteJarPath = `/home/${server.username || 'ec2-user'}/app/app.jar`;
      log(`\r\n[DevMonitor] 📦 jar 전송 중 (SFTP)... → ${server.ec2_ip}:${remoteJarPath}\r\n`);

      const scpResult = await new Promise((resolve) => {
        if (!sshManager) { resolve(false); return; }
        sshManager.sftpUpload(server, b.jar_path, remoteJarPath, (transferred, total) => {
          const pct = Math.round((transferred / total) * 100);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('build:log', `\r[DevMonitor] 전송 중... ${pct}%`);
          }
        })
          .then(() => resolve(true))
          .catch((e) => {
            log(`\r\n[DevMonitor] SFTP 오류: ${e.message}\r\n`);
            resolve(false);
          });
      });

      if (!scpResult) {
        log('\r\n[DevMonitor] ❌ jar 전송 실패\r\n');
        send('build:status', 'failed');
        saveDeploy('failed');
        return;
      }
      log('\r\n[DevMonitor] ✅ jar 전송 완료\r\n');

      if (b.ec2_restart_cmd) {
        log(`\r\n[DevMonitor] 🔄 EC2 재시작: ${b.ec2_restart_cmd}\r\n`);
        // 시스템 ssh 대신 ssh2로 재시작 — Windows/Mac 공통 동작
        const restartResult = await new Promise((resolve) => {
          if (!sshManager) { resolve(false); return; }
          sshManager.diagExec(server.id, b.ec2_restart_cmd, (output, err) => {
            if (output) log(output.replace(/\n/g, '\r\n'));
            resolve(!err);
          });
        });
        if (restartResult) {
          log('\r\n[DevMonitor] ✅ 재시작 완료\r\n');
          send('build:status', 'success');
          saveDeploy('success');
        } else {
          log('\r\n[DevMonitor] ❌ 재시작 실패 (서버 연결 확인)\r\n');
          send('build:status', 'failed');
          saveDeploy('failed');
        }
      } else {
        send('build:status', 'success');
        saveDeploy('success');
      }
    }
  });

  ipcMain.handle('config:set-project-path', (_, projectPath) => {
    if (!config) config = { servers: [], project_path: '' };
    config.project_path = projectPath;
    saveConfig(config);
    return { success: true, project_path: config.project_path };
  });

  ipcMain.handle('server:add', (_, server) => {
    if (!config) config = { servers: [] };
    const errors = validateServer(server);
    if (errors.length > 0) return { success: false, errors };
    if (config.servers.some(s => s.id === server.id)) {
      return { success: false, errors: ['이미 존재하는 서버 ID입니다: ' + server.id] };
    }
    config.servers.push(server);
    saveConfig(config);
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
    if (sshManager) {
      sshManager.disconnectServer(server.id);
      connectSingleServer(server);
    }
    return { success: true, servers: config.servers };
  });

  ipcMain.handle('server:delete', (_, serverId) => {
    if (sshManager) sshManager.disconnectServer(serverId);
    config.servers = config.servers.filter(s => s.id !== serverId);
    saveConfig(config);
    return { success: true, servers: config.servers };
  });

  ipcMain.on('tab:switch', (_, serverId) => { activeTabServerId = serverId; });
  ipcMain.on('mode:set', (_, mode) => { currentMode = mode; });
  ipcMain.on('notification:toggle', (_, enabled) => { notificationsEnabled = enabled; });

  ipcMain.on('pty:write', (_, data) => { if (ptyManager) ptyManager.write(data); });
  ipcMain.on('pty:resize', (_, { cols, rows }) => { if (ptyManager) ptyManager.resize(cols, rows); });

  ipcMain.on('ssh-btop:write', (_, { serverId, data }) => {
    if (sshManager) sshManager.writeBtop(serverId, data);
  });
  ipcMain.on('ssh-btop:resize', (_, { serverId, cols, rows }) => {
    if (sshManager) sshManager.resizeBtop(serverId, cols, rows);
  });

  ipcMain.on('error:resolve', (_, compositeKey) => {
    console.log('[Resolve] compositeKey:', compositeKey);
    let file = null, line = null, serverId = null, errorKey = null;

    if (errorDetector) {
      const group = errorDetector.groups.get(compositeKey);
      if (group) { file = group.file; line = group.line; serverId = group.serverId; errorKey = group.errorKey; }
    }
    if (!file && errorDB) {
      const row = errorDB.getByCompositeKey(compositeKey);
      if (row && row.file_location) {
        const parts = row.file_location.split(':');
        file = parts[0]; line = parts[1] || '0'; serverId = row.server_id; errorKey = row.error_key;
      }
    }

    if (!file || file === 'unknown' || file === 'frontend' || !line || line === '0') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:status', { type: 'info', message: '파일 위치를 특정할 수 없습니다' });
      }
    } else {
      const projectPath = config && config.project_path ? config.project_path : '';
      const foundPath = projectPath ? findFileRecursive(projectPath, file) : null;
      if (foundPath) {
        const codeCmd = getVSCodeCommand();
        require('child_process').exec(`"${codeCmd}" -g "${foundPath}:${line}"`, (err) => {
          if (err) console.error('[Resolve] exec error:', err);
        });
      }
    }

    if (errorDB && serverId && errorKey) errorDB.resolve(serverId, errorKey);
  });

  ipcMain.on('error:unresolve', (_, compositeKey) => {
    if (!errorDB) return;
    const parts = compositeKey.split('::');
    if (parts.length === 2) errorDB.unresolve(parts[0], parts[1]);
  });

  ipcMain.on('error:delete', (_, compositeKeys) => {
    if (!errorDB) return;
    if (compositeKeys === 'ALL') errorDB.deleteAll();
    else errorDB.deleteMany(compositeKeys);
  });

  ipcMain.handle('error:get-history', () => {
    if (errorDB) return errorDB.getAll();
    return [];
  });

  ipcMain.handle('deploy:get-history', () => {
    if (errorDB) return errorDB.getAllDeploys();
    return [];
  });

  // Analysis reports / 통계 대시보드
  ipcMain.handle('report:get-all', () => {
    if (errorDB) return errorDB.getAllReports();
    return [];
  });
  ipcMain.handle('report:get-config', () => {
    return (config && config.auto_report) || { enabled: false, interval_hours: 24 };
  });
  ipcMain.handle('report:save-config', (_, cfg) => {
    if (!config) config = { servers: [] };
    config.auto_report = cfg;
    saveConfig(config);
    resetAutoReportTimer();
    return { success: true };
  });
  ipcMain.on('report:run-now', () => runAutoReport());
  ipcMain.handle('report:get-stats', (_, modifier) => {
    if (errorDB) return errorDB.getStats(modifier);
    return null;
  });
}

// --- SSH connection helpers ---
function connectSingleServer(server) {
  if (!sshManager) return;
  sshManager.connectServer(
    server,
    (serverId, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ssh-log:data', serverId, data);
      }
      if (errorDetector) {
        const srv = config.servers.find(s => s.id === serverId);
        const serverName = srv ? srv.name : serverId;
        data.split('\n').filter(Boolean).forEach(line => {
          errorDetector.processLine(line, serverId, serverName);
        });
      }
    },
    (serverId, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ssh-btop:data', serverId, data);
      }
    },
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
      if (errorDB) {
        const parts = errorKey.split('::');
        if (parts.length === 2) errorDB.updateAnalysis(parts[0], parts[1], analysis);
      }
    });
    ptyManager.setReportAnalysisCallback((analysis) => {
      console.log('[Report] Claude 분석 캡처됨, 길이:', analysis.length, analysis.substring(0, 80));
      if (errorDB) errorDB.updateReportAnalysis(analysis);
      const { BrowserWindow: _BWR } = require('electron');
      for (const win of _BWR.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('report:analysis-updated', { analysis });
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

  try {
    const SSHManager = require('./ssh');
    if (sshManager) sshManager.dispose();
    sshManager = new SSHManager();
    for (const server of config.servers) connectSingleServer(server);
  } catch (e) {
    console.error('SSH 모듈 로드 실패:', e.message);
  }
}

// --- Error handling callbacks ---
function onNewError(compositeKey, group) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('error:detected', { key: compositeKey, group });
  }
  if (errorDB) {
    errorDB.upsert(
      group.serverId, group.serverName, group.errorKey,
      group.errorType, group.file ? `${group.file}:${group.line}` : null
    );
  }

  const server = config ? config.servers.find(s => s.id === group.serverId) : null;

  if (currentMode === 'A') {
    const text = group.rawText || `${group.errorType} @ ${group.file}:${group.line}`;
    clipboard.writeText(text);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard:copy', compositeKey);
    }
    const errorPrompt = `다음 서버 에러를 분석하고 수정 방안을 제시해줘 (코드 수정은 하지 마): ${text}`;
    if (ptyManager) ptyManager.injectWithoutEnter(errorPrompt);
  }

  if (currentMode === 'B' && ptyManager && server) {
    const prompt = `다음 서버 에러를 분석하고 코드를 수정해줘: ${group.rawText || group.errorType + ' @ ' + group.file + ':' + group.line}`;
    ptyManager.switchContext(server, prompt, compositeKey);
  }

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
  if (errorDB) errorDB.updateCount(group.serverId, group.errorKey);
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
    width: 1400, height: 900, minWidth: 1000, minHeight: 600,
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

  // Menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'DevMonitor',
      submenu: [
        {
          label: '배포 이력',
          click: () => {
            const win = new BrowserWindow({
              width: 800, height: 600,
              title: 'DevMonitor — 배포 이력',
              webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
            });
            win.loadFile('deploy-history.html');
            win.setMenu(null);
          }
        },
        {
          label: '분석 리포트',
          click: () => {
            const win = new BrowserWindow({
              width: 860, height: 640,
              title: 'DevMonitor — 분석 리포트',
              backgroundColor: '#1e1e2e',
              webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
            });
            win.loadFile('analysis-report.html');
            win.setMenu(null);
          }
        },
        { type: 'separator' },
        { label: '종료', role: 'quit' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  config = loadConfig();
  resetAutoReportTimer();

  try {
    const ErrorDetector = require('./errorDetector');
    errorDetector = new ErrorDetector(onNewError, onUpdateError, onFloodWarning);
  } catch (e) {
    console.error('ErrorDetector 로드 실패:', e.message);
  }

  try {
    const ErrorDB = require('./db');
    errorDB = new ErrorDB();
  } catch (e) {
    console.error('DB 초기화 실패:', e.message);
  }

  if (config && config.servers && config.servers.length > 0) {
    activeTabServerId = config.servers[0].id;
    initializeConnections();
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (!config || !config.servers || config.servers.length === 0) {
      mainWindow.webContents.send('app:status', { type: 'info', message: 'config-missing' });
    }
    if (config && config.servers) {
      mainWindow.webContents.send('servers:init', config.servers);
    }
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

process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled Rejection:', err); });
