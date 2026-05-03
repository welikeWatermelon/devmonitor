const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');

// --- State ---
let term1, term2, term3, fit1, fit2, fit3;
let activeServerId = null;
let servers = [];
let serverStatuses = {}; // serverId -> { log: 'connected', btop: 'connected' }
let logBuffers = {};     // serverId -> string (buffered output for non-active tabs)
let btopBuffers = {};    // serverId -> string
let currentMode = 'A';
let notificationsOn = true;

const TERM_OPTIONS = {
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#45475a',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8'
  },
  cursorBlink: true,
  scrollback: 5000
};

// --- Terminal Initialization ---
function initTerminals() {
  // Sector 1 - Claude Code (interactive)
  term1 = new Terminal(TERM_OPTIONS);
  fit1 = new FitAddon();
  term1.loadAddon(fit1);
  term1.loadAddon(new WebLinksAddon());
  term1.open(document.getElementById('terminal1'));
  fit1.fit();

  term1.onData((data) => window.devmonitor.writePty(data));
  window.devmonitor.onPtyData((data) => term1.write(data));

  // Sector 2 - Server Logs (read-only)
  term2 = new Terminal({ ...TERM_OPTIONS, disableStdin: true, cursorBlink: false });
  fit2 = new FitAddon();
  term2.loadAddon(fit2);
  term2.open(document.getElementById('terminal2'));
  fit2.fit();

  // Sector 3 - btop (interactive)
  term3 = new Terminal(TERM_OPTIONS);
  fit3 = new FitAddon();
  term3.loadAddon(fit3);
  term3.open(document.getElementById('terminal3'));
  fit3.fit();

  term3.onData((data) => {
    if (activeServerId) window.devmonitor.writeSshBtop(activeServerId, data);
  });

  // SSH data handlers - route to correct terminal or buffer
  window.devmonitor.onSshLogData((serverId, data) => {
    if (serverId === activeServerId) {
      term2.write(data);
    } else {
      if (!logBuffers[serverId]) logBuffers[serverId] = '';
      logBuffers[serverId] += data;
      // Cap buffer
      if (logBuffers[serverId].length > 50000) {
        logBuffers[serverId] = logBuffers[serverId].slice(-25000);
      }
    }
  });

  window.devmonitor.onSshBtopData((serverId, data) => {
    if (serverId === activeServerId) {
      term3.write(data);
    } else {
      if (!btopBuffers[serverId]) btopBuffers[serverId] = '';
      btopBuffers[serverId] += data;
      if (btopBuffers[serverId].length > 50000) {
        btopBuffers[serverId] = btopBuffers[serverId].slice(-25000);
      }
    }
  });

  // Resize handling
  const doFit = () => {
    fit1.fit();
    fit2.fit();
    fit3.fit();
    const d1 = fit1.proposeDimensions();
    const d3 = fit3.proposeDimensions();
    if (d1) window.devmonitor.resizePty(d1.cols, d1.rows);
    if (d3 && d3.cols >= 80 && d3.rows >= 24 && activeServerId) window.devmonitor.resizeSshBtop(activeServerId, d3.cols, d3.rows);
  };

  window.addEventListener('resize', doFit);
  const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
  ro.observe(document.getElementById('terminal1'));
  ro.observe(document.getElementById('terminal2'));
  ro.observe(document.getElementById('terminal3'));

  // 대시보드 30초 자동 갱신
  setInterval(() => {
    const activeS3Tab = document.querySelector('.s3-tab.active');
    if (activeS3Tab && activeS3Tab.dataset.panel === 'dashboard' && activeServerId) {
      loadDashboard(activeServerId);
    }
  }, 30000);
}

// --- Tab switching ---
function switchTab(serverId) {
  if (serverId === activeServerId) return;

  // Save current terminal state is handled by buffers automatically
  activeServerId = serverId;

  // Clear terminals and load buffered data
  term2.clear();
  term2.reset();
  if (logBuffers[serverId]) {
    term2.write(logBuffers[serverId]);
    logBuffers[serverId] = '';
  }

  term3.clear();
  term3.reset();
  if (btopBuffers[serverId]) {
    term3.write(btopBuffers[serverId]);
    btopBuffers[serverId] = '';
  }

  // Notify main process
  window.devmonitor.switchTab(serverId);

  // 탭 전환 시 실제 xterm 크기를 btop에 즉시 전송
  if (fit3) {
    const d3 = fit3.proposeDimensions();
    if (d3 && d3.cols >= 80 && d3.rows >= 24) {
      window.devmonitor.resizeSshBtop(serverId, d3.cols, d3.rows);
    }
  }

  // Update tab UI
  renderTabs();

  // Update top bar connection status
  updateConnectionStatus();

  // 대시보드 탭이 활성 상태면 갱신
  const activeS3Tab = document.querySelector('.s3-tab.active');
  if (activeS3Tab && activeS3Tab.dataset.panel === 'dashboard') {
    loadDashboard(serverId);
  }
}

function renderTabs() {
  const isSingle = servers.length <= 1;

  // Toggle tab bars vs single-server fallback headers
  document.getElementById('sector2-header-tabs').classList.toggle('hidden-tabs', isSingle);
  document.getElementById('sector3-header-tabs').classList.toggle('hidden-tabs', isSingle);
  document.getElementById('sector2-header-single').classList.toggle('hidden', !isSingle);
  document.getElementById('sector3-header-single').classList.toggle('hidden', !isSingle);

  if (isSingle) return;

  const buildTabs = (containerId) => {
    const bar = document.getElementById(containerId);
    bar.className = 'tab-bar';

    let html = '';
    for (const s of servers) {
      const status = getServerStatus(s.id);
      const isActive = s.id === activeServerId;
      html += `<div class="tab ${isActive ? 'active' : ''}" data-server-id="${s.id}">` +
        `<span class="dot ${status}"></span>${escapeHtml(s.name)}</div>`;
    }

    html += '<div class="tab-add">+</div>';
    bar.innerHTML = html;

    bar.querySelectorAll('.tab[data-server-id]').forEach(el => {
      el.addEventListener('click', () => switchTab(el.dataset.serverId));
    });

    const addBtn = bar.querySelector('.tab-add');
    if (addBtn) {
      addBtn.addEventListener('click', () => toggleTabAddForm());
    }
  };

  buildTabs('log-tab-bar');
  buildTabs('btop-tab-bar');
}

function getServerStatus(serverId) {
  const st = serverStatuses[serverId];
  if (!st) return 'disconnected';
  // Show worst status between log and btop
  if (st.log === 'connected' && st.btop === 'connected') return 'connected';
  if (st.log === 'reconnecting' || st.btop === 'reconnecting') return 'reconnecting';
  return 'disconnected';
}

function updateConnectionStatus() {
  const dot = document.getElementById('connection-status');
  const text = document.getElementById('connection-text');

  if (!activeServerId || servers.length === 0) {
    dot.className = 'status-dot disconnected';
    text.textContent = '끊김';
    return;
  }

  const status = getServerStatus(activeServerId);
  if (status === 'connected') {
    dot.className = 'status-dot connected';
    text.textContent = '연결됨';
  } else if (status === 'reconnecting') {
    dot.className = 'status-dot reconnecting';
    text.textContent = '재연결 중...';
  } else {
    dot.className = 'status-dot disconnected';
    text.textContent = '끊김';
  }
}

// --- SSH Status handler ---
window.devmonitor.onSshStatus((serverId, sector, status) => {
  // 'btop-ready': btop이 실제로 시작된 후 실제 xterm 크기로 resize
  if (status === 'btop-ready') {
    if (serverId === activeServerId && fit3) {
      const d3 = fit3.proposeDimensions();
      if (d3 && d3.cols >= 80 && d3.rows >= 24) {
        window.devmonitor.resizeSshBtop(serverId, d3.cols, d3.rows);
      }
    }
    return; // serverStatuses에 저장 안 함
  }

  if (!serverStatuses[serverId]) serverStatuses[serverId] = { log: 'disconnected', btop: 'disconnected' };
  serverStatuses[serverId][sector] = status;
  renderTabs();
  updateConnectionStatus();
});

// --- Tab add form (accordion) ---
function toggleTabAddForm() {
  const form = document.getElementById('tab-add-form');
  form.classList.toggle('open');
  if (form.classList.contains('open')) {
    clearTabForm();
    document.getElementById('tab-form-submit').textContent = '추가';
    document.getElementById('tab-form-submit').dataset.mode = 'add';
  }
}

function clearTabForm() {
  document.getElementById('tab-srv-id').value = '';
  document.getElementById('tab-srv-name').value = '';
  document.getElementById('tab-srv-pem').value = '';
  document.getElementById('tab-srv-ip').value = '';
  document.getElementById('tab-srv-user').value = 'ec2-user';
  document.getElementById('tab-srv-port').value = '22';
  document.getElementById('tab-srv-log').value = '';
  document.getElementById('tab-srv-diag-pem').value = '';
  document.getElementById('tab-form-errors').textContent = '';
}

document.getElementById('tab-form-cancel').addEventListener('click', () => {
  document.getElementById('tab-add-form').classList.remove('open');
});

document.getElementById('tab-form-submit').addEventListener('click', async () => {
  const btn = document.getElementById('tab-form-submit');
  const mode = btn.dataset.mode || 'add';

  const serverData = {
    id: document.getElementById('tab-srv-id').value.trim(),
    name: document.getElementById('tab-srv-name').value.trim(),
    pem_key_path: document.getElementById('tab-srv-pem').value.trim(),
    ec2_ip: document.getElementById('tab-srv-ip').value.trim(),
    username: document.getElementById('tab-srv-user').value.trim(),
    port: parseInt(document.getElementById('tab-srv-port').value, 10) || 22,
    log_path: document.getElementById('tab-srv-log').value.trim(),
    diag_pem_key_path: document.getElementById('tab-srv-diag-pem').value.trim()
  };

  if (!serverData.id || !serverData.name) {
    document.getElementById('tab-form-errors').textContent = 'ID와 이름은 필수입니다';
    return;
  }

  let result;
  if (mode === 'add') {
    result = await window.devmonitor.addServer(serverData);
  } else {
    result = await window.devmonitor.updateServer(serverData);
  }

  if (result.success) {
    document.getElementById('tab-add-form').classList.remove('open');
    servers = result.servers;
    if (!activeServerId && servers.length > 0) {
      activeServerId = servers[0].id;
    }
    renderTabs();
    renderSettingsServerList();
    showToast(mode === 'add' ? '서버가 추가되었습니다' : '서버가 수정되었습니다');
  } else {
    document.getElementById('tab-form-errors').textContent = result.errors.join(', ');
  }
});

// --- Mode Toggle ---
document.getElementById('mode-a').addEventListener('click', () => {
  currentMode = 'A';
  document.getElementById('mode-a').classList.add('active');
  document.getElementById('mode-b').classList.remove('active');
  document.getElementById('action-btn').textContent = '붙여넣기';
  window.devmonitor.setMode('A');
});

document.getElementById('mode-b').addEventListener('click', () => {
  currentMode = 'B';
  document.getElementById('mode-b').classList.add('active');
  document.getElementById('mode-a').classList.remove('active');
  document.getElementById('action-btn').textContent = '분석하기';
  window.devmonitor.setMode('B');
});

document.getElementById('action-btn').addEventListener('click', () => {
  if (currentMode === 'A') {
    term1.focus();
  } else {
    showToast('최신 에러를 Claude Code에 전송합니다...');
  }
});

// --- Notification Toggle ---
document.getElementById('notification-toggle').addEventListener('click', () => {
  notificationsOn = !notificationsOn;
  document.getElementById('notification-toggle').textContent = notificationsOn ? '🔔' : '🔕';
  window.devmonitor.toggleNotification(notificationsOn);
});

// --- Settings Popup ---
const settingsPopup = document.getElementById('settings-popup');

document.getElementById('settings-btn').addEventListener('click', () => {
  settingsPopup.classList.toggle('hidden');
  if (!settingsPopup.classList.contains('hidden')) {
    renderSettingsServerList();
    // project_path 초기값 로드
    window.devmonitor.loadConfig().then(cfg => {
      if (cfg && cfg.project_path) {
        document.getElementById('settings-project-path').value = cfg.project_path;
      }
    });
    // 빌드 설정 로드
    window.devmonitor.getBuildConfig().then(b => {
      if (b) {
        document.getElementById('settings-os').value = b.os || 'windows';
        document.getElementById('settings-deploy-mode').value = b.deploy_mode || 'direct';
        document.getElementById('settings-build-command').value = b.command || '';
        document.getElementById('settings-build-dir').value = b.work_dir || '';
        document.getElementById('settings-build-jar').value = b.jar_path || '';
        document.getElementById('settings-ec2-restart').value = b.ec2_restart_cmd || '';
        document.getElementById('settings-git-dir').value = b.git_work_dir || '';
        // 배포 대상 서버 드롭다운
        const serverSelect = document.getElementById('settings-deploy-server');
        serverSelect.innerHTML = servers.map(s =>
          `<option value="${s.id}" ${s.id === b.deploy_server_id ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        toggleDeployFields(b.deploy_mode || 'direct');
      }
    });
    // deny 규칙 상태 표시
    window.devmonitor.getDenyRulesStatus().then(status => {
      const el = document.getElementById('deny-rules-status');
      if (status.installed) {
        el.textContent = `현재 ${status.count}개 deny 규칙이 설치되어 있습니다.`;
        el.style.color = '#a6e3a1';
      } else {
        el.textContent = '아직 deny 규칙이 설치되지 않았습니다.';
        el.style.color = '#f9e2af';
      }
    });
    // 자동 분석 리포트 설정 로드
    if (window.devmonitor.getReportConfig) {
      window.devmonitor.getReportConfig().then(cfg => {
        const enabledEl = document.getElementById('settings-auto-report-enabled');
        const hoursEl = document.getElementById('settings-auto-report-hours');
        if (enabledEl) enabledEl.checked = !!(cfg && cfg.enabled);
        if (hoursEl) hoursEl.value = (cfg && cfg.interval_hours) || 24;
      });
    }
  }
});

document.getElementById('settings-project-path-save').addEventListener('click', async () => {
  const projectPath = document.getElementById('settings-project-path').value.trim();
  const result = await window.devmonitor.setProjectPath(projectPath);
  if (result && result.success) {
    showToast('프로젝트 경로가 저장되었습니다');
  }
});

// 자동 분석 리포트 설정 저장
document.getElementById('settings-report-save').addEventListener('click', async () => {
  const enabled = document.getElementById('settings-auto-report-enabled').checked;
  const interval_hours = parseInt(document.getElementById('settings-auto-report-hours').value, 10) || 24;
  if (window.devmonitor.saveReportConfig) {
    const result = await window.devmonitor.saveReportConfig({ enabled, interval_hours });
    if (result && result.success) {
      showToast(enabled
        ? `자동 분석 활성화 — ${interval_hours}시간마다 실행`
        : '자동 분석이 비활성화되었습니다');
    }
  }
});

// 자동 분석 완료 토스트
if (window.devmonitor.onAutoReportDone) {
  window.devmonitor.onAutoReportDone((data) => {
    showToast(`📊 자동 분석 완료 — ${data.count}건 에러 집계`);
  });
}

document.getElementById('install-deny-rules-btn').addEventListener('click', async () => {
  const result = await window.devmonitor.installDenyRules();
  if (result && result.success) {
    showToast(`안전 규칙 ${result.count}개가 설치되었습니다`);
    const el = document.getElementById('deny-rules-status');
    el.textContent = `현재 ${result.count}개 deny 규칙이 설치되어 있습니다.`;
    el.style.color = '#a6e3a1';
  }
});

document.getElementById('settings-build-save').addEventListener('click', async () => {
  const buildCfg = {
    os: document.getElementById('settings-os').value,
    deploy_mode: document.getElementById('settings-deploy-mode').value,
    command: document.getElementById('settings-build-command').value.trim(),
    work_dir: document.getElementById('settings-build-dir').value.trim(),
    jar_path: document.getElementById('settings-build-jar').value.trim(),
    deploy_server_id: document.getElementById('settings-deploy-server').value,
    ec2_restart_cmd: document.getElementById('settings-ec2-restart').value.trim(),
    git_work_dir: document.getElementById('settings-git-dir').value.trim()
  };
  const result = await window.devmonitor.saveBuildConfig(buildCfg);
  if (result && result.success) {
    showToast('빌드/배포 설정이 저장되었습니다');
    updateDeployBadge();
  }
});

// 배포 방식 필드 토글
function toggleDeployFields(mode) {
  document.getElementById('deploy-direct-fields').style.display = mode === 'direct' ? '' : 'none';
  document.getElementById('deploy-github-fields').style.display = mode === 'github' ? '' : 'none';
}

document.getElementById('settings-deploy-mode').addEventListener('change', (e) => {
  toggleDeployFields(e.target.value);
});

// 상단 배지 업데이트
async function updateDeployBadge() {
  const b = await window.devmonitor.getBuildConfig();
  const badge = document.getElementById('deploy-badge');
  if (!badge || !b) return;
  const osLabel = b.os === 'mac' ? '\uD83C\uDF4E Mac' : '\uD83E\uDE9F Win';
  const modeLabel = b.deploy_mode === 'github' ? '\u26A1 GitHub Actions' : '\uD83D\uDCE6 직접전송';
  badge.textContent = `${osLabel} \u00B7 ${modeLabel}`;
}
updateDeployBadge();

document.getElementById('settings-close').addEventListener('click', () => {
  settingsPopup.classList.add('hidden');
});

// Settings: server list rendering
function renderSettingsServerList() {
  const list = document.getElementById('server-list');
  list.innerHTML = '';

  for (const s of servers) {
    const item = document.createElement('div');
    item.className = 'server-item';
    item.dataset.serverId = s.id;
    item.innerHTML = `
      <div class="server-item-info">
        <span class="server-item-name">${escapeHtml(s.name)}</span>
        <span class="server-item-ip">${escapeHtml(s.ec2_ip)}</span>
      </div>
      <div class="server-item-actions">
        <button class="server-item-btn edit">수정</button>
        <button class="server-item-btn delete">삭제</button>
      </div>
    `;

    item.querySelector('.edit').addEventListener('click', () => {
      openEditForm(s);
    });

    item.querySelector('.delete').addEventListener('click', async () => {
      const result = await window.devmonitor.deleteServer(s.id);
      if (result.success) {
        servers = result.servers;
        if (activeServerId === s.id) {
          activeServerId = servers.length > 0 ? servers[0].id : null;
        }
        renderTabs();
        renderSettingsServerList();
        showToast(`${s.name} 서버가 삭제되었습니다`);
      }
    });

    list.appendChild(item);
  }
}

// Settings: accordion add server
document.getElementById('settings-add-server').addEventListener('click', () => {
  const accordion = document.getElementById('settings-add-form');
  const btn = document.getElementById('settings-add-server');

  if (accordion.classList.contains('open')) {
    accordion.classList.remove('open');
    btn.textContent = '+ 서버 추가 ▼';
  } else {
    accordion.classList.add('open');
    btn.textContent = '+ 서버 추가 ▲';
    accordion.innerHTML = buildServerFormHTML('settings', 'add');
    attachSettingsFormHandlers('add', null);
  }
});

function openEditForm(server) {
  const accordion = document.getElementById('settings-add-form');
  const btn = document.getElementById('settings-add-server');
  accordion.classList.add('open');
  btn.textContent = '+ 서버 추가 ▲';

  accordion.innerHTML = buildServerFormHTML('settings', 'edit', server);
  attachSettingsFormHandlers('edit', server.id);
}

function buildServerFormHTML(prefix, mode, server) {
  const s = server || {};
  return `
    <div class="tab-form-inner">
      <div class="tab-form-title">${mode === 'edit' ? '수정 중: ' + escapeHtml(s.name || '') : '서버 추가'}</div>
      <div class="tab-form-row"><label>ID</label><input type="text" id="${prefix}-f-id" value="${escapeHtml(s.id || '')}" ${mode === 'edit' ? 'readonly style="opacity:0.5"' : ''}></div>
      <div class="tab-form-row"><label>이름</label><input type="text" id="${prefix}-f-name" value="${escapeHtml(s.name || '')}"></div>
      <div class="tab-form-row"><label>PEM 경로</label><input type="text" id="${prefix}-f-pem" value="${escapeHtml(s.pem_key_path || '')}"></div>
      <div class="tab-form-row"><label>EC2 IP</label><input type="text" id="${prefix}-f-ip" value="${escapeHtml(s.ec2_ip || '')}"></div>
      <div class="tab-form-row"><label>사용자명</label><input type="text" id="${prefix}-f-user" value="${escapeHtml(s.username || 'ec2-user')}"></div>
      <div class="tab-form-row"><label>포트</label><input type="number" id="${prefix}-f-port" value="${s.port || 22}"></div>
      <div class="tab-form-row"><label>로그 경로</label><input type="text" id="${prefix}-f-log" value="${escapeHtml(s.log_path || '')}"></div>
      <div class="tab-form-row"><label>진단 키 경로 (선택)</label><input type="text" id="${prefix}-f-diag-pem" value="${escapeHtml(s.diag_pem_key_path || '')}" placeholder="ForceCommand 전용 PEM (없으면 기본 키 사용)"></div>
      <div id="${prefix}-f-errors" class="tab-form-errors"></div>
      <div class="tab-form-actions">
        <button id="${prefix}-f-cancel" class="tab-form-btn cancel">취소</button>
        <button id="${prefix}-f-submit" class="tab-form-btn submit">${mode === 'edit' ? '저장' : '추가'}</button>
      </div>
    </div>
  `;
}

function attachSettingsFormHandlers(mode, editId) {
  const prefix = 'settings';

  document.getElementById(`${prefix}-f-cancel`).addEventListener('click', () => {
    document.getElementById('settings-add-form').classList.remove('open');
    document.getElementById('settings-add-server').textContent = '+ 서버 추가 ▼';
  });

  document.getElementById(`${prefix}-f-submit`).addEventListener('click', async () => {
    const errorsDiv = document.getElementById(`${prefix}-f-errors`);
    errorsDiv.textContent = '';
    errorsDiv.style.color = '#f38ba8';
    errorsDiv.style.marginTop = '8px';

    try {
      const serverData = {
        id: document.getElementById(`${prefix}-f-id`).value.trim(),
        name: document.getElementById(`${prefix}-f-name`).value.trim(),
        pem_key_path: document.getElementById(`${prefix}-f-pem`).value.trim(),
        ec2_ip: document.getElementById(`${prefix}-f-ip`).value.trim(),
        username: document.getElementById(`${prefix}-f-user`).value.trim(),
        port: parseInt(document.getElementById(`${prefix}-f-port`).value, 10) || 22,
        log_path: document.getElementById(`${prefix}-f-log`).value.trim(),
        diag_pem_key_path: document.getElementById(`${prefix}-f-diag-pem`).value.trim()
      };

      if (!serverData.id || !serverData.name) {
        errorsDiv.textContent = 'ID와 이름은 필수입니다';
        return;
      }

      let result;
      if (mode === 'edit') {
        result = await window.devmonitor.updateServer(serverData);
      } else {
        result = await window.devmonitor.addServer(serverData);
      }

      if (!result) {
        console.error('[Settings] 서버 추가/수정 결과가 없습니다 (result is null/undefined)');
        errorsDiv.textContent = '서버 추가에 실패했습니다. 응답이 없습니다.';
        return;
      }

      if (result.success) {
        console.log(`[Settings] 서버 ${mode === 'edit' ? '수정' : '추가'} 성공:`, serverData.id);
        servers = result.servers;
        if (!activeServerId && servers.length > 0) {
          activeServerId = servers[0].id;
        }
        document.getElementById('settings-add-form').classList.remove('open');
        document.getElementById('settings-add-server').textContent = '+ 서버 추가 ▼';
        renderTabs();
        renderSettingsServerList();
        showToast(mode === 'edit' ? '서버가 수정되었습니다' : '서버가 추가되었습니다');
      } else {
        console.error(`[Settings] 서버 ${mode === 'edit' ? '수정' : '추가'} 실패:`, result.errors);
        errorsDiv.textContent = (result.errors || ['알 수 없는 오류']).join(', ');
      }
    } catch (err) {
      console.error('[Settings] 서버 추가/수정 중 예외 발생:', err);
      errorsDiv.textContent = '오류: ' + (err.message || '알 수 없는 오류가 발생했습니다');
    }
  });
}

// --- Error Panel ---
const errorElements = new Map();
const checkedKeys = new Set();

window.devmonitor.onErrorDetected(({ key, group }) => {
  addErrorToPanel(key, group);
});

window.devmonitor.onErrorUpdated(({ key, group }) => {
  updateErrorInPanel(key, group);
});

window.devmonitor.onErrorAnalysis(({ key, analysis }) => {
  const el = errorElements.get(key);
  if (el) {
    const analysisEl = el.querySelector('.error-analysis');
    analysisEl.textContent = analysis;
    analysisEl.classList.add('has-content');
  }
});

window.devmonitor.onErrorHistory((history) => {
  history.forEach(row => {
    const compositeKey = `${row.server_id}::${row.error_key}`;
    const group = {
      serverId: row.server_id,
      serverName: row.server_name,
      errorKey: row.error_key,
      errorType: row.error_type,
      file: row.file_location ? row.file_location.split(':')[0] : '',
      line: row.file_location ? row.file_location.split(':')[1] : '',
      timestamps: [row.first_seen],
      count: row.count,
      analysis: row.analysis,
      resolved: row.resolved === 1
    };
    addErrorToPanel(compositeKey, group);
  });
});

function addErrorToPanel(key, group) {
  if (errorElements.has(key)) {
    updateErrorInPanel(key, group);
    return;
  }

  const div = document.createElement('div');
  div.className = 'error-group' + (group.resolved ? ' resolved' : '');
  div.dataset.key = key;

  const timestamps = (group.timestamps || []).map(t => {
    const d = new Date(t);
    return `<span>${d.toLocaleTimeString('ko-KR')}</span>`;
  }).join('');

  const serverLabel = group.serverName
    ? `<div class="error-server-label">${escapeHtml(group.serverName)}</div>` : '';

  div.innerHTML = `
    <input type="checkbox" class="err-checkbox" data-key="${escapeHtml(key)}">
    ${serverLabel}
    <div class="error-key">${escapeHtml(group.errorType || '')} @ ${escapeHtml((group.file || '') + ':' + (group.line || ''))}</div>
    <div class="error-timestamps">${timestamps}</div>
    <div class="error-count">발생 횟수: ${group.count || 1}</div>
    <div class="error-analysis ${group.analysis ? 'has-content' : ''}">${escapeHtml(group.analysis || '')}</div>
    <div class="err-actions">
      ${group.resolved
        ? '<button class="unresolve-btn">\u21A9 미해결로</button>'
        : '<button class="resolve-btn">\u2705 해결완료</button>'}
    </div>
  `;

  div.querySelector('.err-checkbox').addEventListener('change', (e) => {
    if (e.target.checked) checkedKeys.add(key);
    else checkedKeys.delete(key);
  });

  const resolveBtn = div.querySelector('.resolve-btn');
  const unresolveBtn = div.querySelector('.unresolve-btn');
  if (resolveBtn) {
    resolveBtn.addEventListener('click', () => {
      window.devmonitor.resolveError(key);
      moveToResolved(key, div);
    });
  }
  if (unresolveBtn) {
    unresolveBtn.addEventListener('click', () => {
      window.devmonitor.unresolveError(key);
      moveToUnresolved(key, div);
    });
  }

  if (group.resolved) {
    document.getElementById('error-list-resolved').prepend(div);
  } else {
    document.getElementById('error-list-unresolved').prepend(div);
  }
  errorElements.set(key, div);

  // 에러 타입 드롭다운에 없으면 추가
  const typeSelect = document.getElementById('filter-type');
  const errorType = group.errorType || '';
  if (errorType && ![...typeSelect.options].find(o => o.value === errorType)) {
    const opt = document.createElement('option');
    opt.value = errorType;
    opt.textContent = errorType;
    typeSelect.appendChild(opt);
  }

  applyFilter();
}

function moveToResolved(key, div) {
  div.classList.add('resolved');
  const actions = div.querySelector('.err-actions');
  actions.innerHTML = '<button class="unresolve-btn">\u21A9 미해결로</button>';
  actions.querySelector('.unresolve-btn').addEventListener('click', () => {
    window.devmonitor.unresolveError(key);
    moveToUnresolved(key, div);
  });
  document.getElementById('error-list-resolved').prepend(div);
}

function moveToUnresolved(key, div) {
  div.classList.remove('resolved');
  const actions = div.querySelector('.err-actions');
  actions.innerHTML = '<button class="resolve-btn">\u2705 해결완료</button>';
  actions.querySelector('.resolve-btn').addEventListener('click', () => {
    window.devmonitor.resolveError(key);
    moveToResolved(key, div);
  });
  document.getElementById('error-list-unresolved').prepend(div);
}

function updateErrorInPanel(key, group) {
  const el = errorElements.get(key);
  if (!el) return;

  const timestamps = (group.timestamps || []).map(t => {
    const d = new Date(t);
    return `<span>${d.toLocaleTimeString('ko-KR')}</span>`;
  }).join('');

  el.querySelector('.error-timestamps').innerHTML = timestamps;
  el.querySelector('.error-count').textContent = `발생 횟수: ${group.count || 1}`;
}

document.getElementById('err-delete-selected').addEventListener('click', () => {
  if (checkedKeys.size === 0) { showToast('선택된 에러가 없습니다'); return; }
  const keys = [...checkedKeys];
  window.devmonitor.deleteErrors(keys);
  keys.forEach(key => {
    const el = errorElements.get(key);
    if (el) el.remove();
    errorElements.delete(key);
    checkedKeys.delete(key);
  });
  showToast(`${keys.length}개 삭제됨`);
});

document.getElementById('err-delete-all').addEventListener('click', () => {
  window.devmonitor.deleteErrors('ALL');
  errorElements.forEach(el => el.remove());
  errorElements.clear();
  checkedKeys.clear();
  showToast('전체 삭제됨');
});

// --- Error Filter ---
const filterState = { server: 'ALL', type: 'ALL', date: 'ALL' };

function applyFilter() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  errorElements.forEach((div, key) => {
    const serverId = key.split('::')[0];
    const errorType = div.querySelector('.error-key')?.textContent || '';
    const timeEl = div.querySelector('.error-timestamps span');
    const timeText = timeEl?.textContent || '';

    let show = true;
    if (filterState.server !== 'ALL' && serverId !== filterState.server) show = false;
    if (filterState.type !== 'ALL' && !errorType.includes(filterState.type)) show = false;
    if (filterState.date !== 'ALL' && timeText) {
      const today = new Date();
      const parts = timeText.match(/(\d+):(\d+):(\d+)/);
      if (parts) {
        const errorTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), +parts[1], +parts[2], +parts[3]);
        if (filterState.date === 'TODAY' && errorTime < todayStart) show = false;
        if (filterState.date === 'WEEK' && errorTime < weekStart) show = false;
      }
    }

    div.style.display = show ? '' : 'none';
  });
}

document.getElementById('filter-server').addEventListener('change', (e) => {
  filterState.server = e.target.value;
  applyFilter();
});
document.getElementById('filter-type').addEventListener('change', (e) => {
  filterState.type = e.target.value;
  applyFilter();
});
document.getElementById('filter-date').addEventListener('change', (e) => {
  filterState.date = e.target.value;
  applyFilter();
});
document.getElementById('filter-reset').addEventListener('click', () => {
  filterState.server = 'ALL';
  filterState.type = 'ALL';
  filterState.date = 'ALL';
  document.getElementById('filter-server').value = 'ALL';
  document.getElementById('filter-type').value = 'ALL';
  document.getElementById('filter-date').value = 'ALL';
  applyFilter();
});

// --- Toast ---
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

window.devmonitor.onClipboardCopy(() => {
  showToast('에러가 클립보드에 복사되었습니다');
});

window.devmonitor.onAppStatus(({ type, message }) => {
  if (message === 'config-missing') {
    settingsPopup.classList.remove('hidden');
    showToast('설정을 먼저 입력해주세요.');
  } else {
    showToast(message);
  }
});

window.devmonitor.onServersInit((srvList) => {
  servers = srvList;
  if (servers.length > 0 && !activeServerId) {
    activeServerId = servers[0].id;
  }
  renderTabs();
  updateConnectionStatus();
  // 필터 서버 드롭다운 채우기
  const serverSelect = document.getElementById('filter-server');
  srvList.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    serverSelect.appendChild(opt);
  });
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Build ---
document.getElementById('build-btn').addEventListener('click', () => {
  const btn = document.getElementById('build-btn');
  if (btn.disabled) return;
  window.devmonitor.startBuild();
});

window.devmonitor.onBuildLog((data) => {
  if (term1) term1.write(data);
});

window.devmonitor.onBuildStatus((status) => {
  const btn = document.getElementById('build-btn');
  if (status === 'running') {
    btn.textContent = '\u23F3 빌드 중...';
    btn.disabled = true;
  } else if (status === 'success') {
    btn.textContent = '\u2705 빌드 완료';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '\uD83D\uDD28 빌드'; }, 3000);
  } else if (status === 'failed') {
    btn.textContent = '\u274C 빌드 실패';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '\uD83D\uDD28 빌드'; }, 3000);
  }
});

// --- Sector 3 Dashboard ---
document.querySelectorAll('.s3-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.s3-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const panel = btn.dataset.panel;
    document.getElementById('panel-dashboard').classList.toggle('hidden', panel !== 'dashboard');
    document.getElementById('panel-btop').classList.toggle('hidden', panel !== 'btop');
    if (panel === 'dashboard' && activeServerId) loadDashboard(activeServerId);
    if (panel === 'btop' && fit3) {
      requestAnimationFrame(() => fit3.fit());
    }
  });
});

document.getElementById('dashboard-refresh').addEventListener('click', () => {
  if (activeServerId) loadDashboard(activeServerId);
});

async function loadDashboard(serverId) {
  const grid = document.getElementById('dashboard-grid');
  grid.innerHTML = '<div style="color:#6c7086;padding:16px;">수집 중...</div>';

  const [memRes, dfRes, loadRes] = await Promise.all([
    window.devmonitor.diagExec(serverId, 'free -m'),
    window.devmonitor.diagExec(serverId, 'df -h /'),
    window.devmonitor.diagExec(serverId, 'cat /proc/loadavg')
  ]);

  // free -m 파싱
  let memUsed = '--', memTotal = '--', memPct = 0;
  const memLine = memRes.output.split('\n').find(l => l.startsWith('Mem:'));
  if (memLine) {
    const parts = memLine.trim().split(/\s+/);
    memTotal = parts[1]; memUsed = parts[2];
    memPct = Math.round((+parts[2] / +parts[1]) * 100);
  }

  // df -h 파싱
  let diskUsed = '--', diskTotal = '--', diskPct = '--';
  const dfLine = dfRes.output.split('\n').find(l => l.includes('/') && !l.startsWith('Filesystem'));
  if (dfLine) {
    const p = dfLine.trim().split(/\s+/);
    diskTotal = p[1]; diskUsed = p[2]; diskPct = p[4];
  }

  // loadavg 파싱
  const loadParts = loadRes.output.trim().split(' ');
  const load1 = loadParts[0] || '--';
  const load5 = loadParts[1] || '--';

  // 24h 에러 건수
  const errCnt = getTodayErrorCount(serverId);

  grid.innerHTML = `
    ${dashCard('Load Avg (1m)', load1, '5m: ' + load5, +load1 > 2 ? 'warn' : '')}
    ${dashCard('Memory', memPct + '%', memUsed + 'M / ' + memTotal + 'M used', memPct > 80 ? 'warn' : '')}
    ${dashCard('Disk /', diskPct, diskUsed + ' / ' + diskTotal, parseInt(diskPct) > 80 ? 'warn' : '')}
    ${dashCard('24h ERROR', errCnt + '건', '에러 분석 로그 기준', errCnt > 0 ? 'alert' : '')}
  `;
}

function dashCard(title, value, sub, cls) {
  return `<div class="dash-card ${cls || ''}">
    <div class="card-title">${title}</div>
    <div class="card-value">${value}</div>
    <div class="card-sub">${sub}</div>
  </div>`;
}

function getTodayErrorCount(serverId) {
  let count = 0;
  errorElements.forEach((el, key) => {
    if (key.startsWith(serverId + '::')) count++;
  });
  return count;
}

// --- Platform-aware placeholders ---
function applyPlatformPlaceholders() {
  const isMac = window.devmonitor && window.devmonitor.platform === 'darwin';
  const ph = isMac ? {
    pem: '/Users/yourname/.ssh/server.pem',
    localPath: '/Users/yourname/projects/backend',
    projectPath: '/Users/yourname/projects/myapp',
    buildCmd: './mvnw clean package -DskipTests',
    buildDir: '/Users/yourname/projects/myapp/backend',
    buildJar: '/Users/yourname/projects/myapp/backend/target/app.jar',
    gitDir: '/Users/yourname/projects/myapp'
  } : {
    pem: 'C:/Users/yourname/.ssh/server.pem',
    localPath: 'C:/Users/yourname/projects/backend',
    projectPath: 'C:\\Projects\\myapp',
    buildCmd: '.\\mvnw.cmd clean package -DskipTests',
    buildDir: 'C:\\Projects\\myapp\\backend',
    buildJar: 'C:\\...\\target\\demo-0.0.1-SNAPSHOT.jar',
    gitDir: 'C:\\Projects\\myapp'
  };

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.placeholder = val; };
  set('tab-srv-pem', ph.pem);
  set('tab-srv-local', ph.localPath);
  set('settings-project-path', ph.projectPath);
  set('settings-build-command', ph.buildCmd);
  set('settings-build-dir', ph.buildDir);
  set('settings-build-jar', ph.buildJar);
  set('settings-git-dir', ph.gitDir);

}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initTerminals();
  applyPlatformPlaceholders();
});
