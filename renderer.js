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
    if (d3 && activeServerId) window.devmonitor.resizeSshBtop(activeServerId, d3.cols, d3.rows);
  };

  window.addEventListener('resize', doFit);
  const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
  ro.observe(document.getElementById('terminal1'));
  ro.observe(document.getElementById('terminal2'));
  ro.observe(document.getElementById('terminal3'));
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

  // Update tab UI
  renderTabs();

  // Update top bar connection status
  updateConnectionStatus();
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
  document.getElementById('tab-srv-local').value = '';
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
    local_path: document.getElementById('tab-srv-local').value.trim()
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
  }
});

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
      <div class="tab-form-row"><label>로컬 경로</label><input type="text" id="${prefix}-f-local" value="${escapeHtml(s.local_path || '')}"></div>
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
    const serverData = {
      id: document.getElementById(`${prefix}-f-id`).value.trim(),
      name: document.getElementById(`${prefix}-f-name`).value.trim(),
      pem_key_path: document.getElementById(`${prefix}-f-pem`).value.trim(),
      ec2_ip: document.getElementById(`${prefix}-f-ip`).value.trim(),
      username: document.getElementById(`${prefix}-f-user`).value.trim(),
      port: parseInt(document.getElementById(`${prefix}-f-port`).value, 10) || 22,
      log_path: document.getElementById(`${prefix}-f-log`).value.trim(),
      local_path: document.getElementById(`${prefix}-f-local`).value.trim()
    };

    if (!serverData.id || !serverData.name) {
      document.getElementById(`${prefix}-f-errors`).textContent = 'ID와 이름은 필수입니다';
      return;
    }

    let result;
    if (mode === 'edit') {
      result = await window.devmonitor.updateServer(serverData);
    } else {
      result = await window.devmonitor.addServer(serverData);
    }

    if (result.success) {
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
      document.getElementById(`${prefix}-f-errors`).textContent = result.errors.join(', ');
    }
  });
}

// --- Error Panel ---
const errorList = document.getElementById('error-list');
const errorElements = new Map();

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
    ? `<div class="error-server-label">${escapeHtml(group.serverName)}</div>`
    : '';

  div.innerHTML = `
    ${serverLabel}
    <div class="error-key">${escapeHtml(group.errorType || '')} @ ${escapeHtml((group.file || '') + ':' + (group.line || ''))}</div>
    <div class="error-timestamps">${timestamps}</div>
    <div class="error-count">발생 횟수: ${group.count || 1}</div>
    <div class="error-analysis ${group.analysis ? 'has-content' : ''}">${escapeHtml(group.analysis || '')}</div>
    <button class="resolve-btn">해결하기</button>
  `;

  div.querySelector('.resolve-btn').addEventListener('click', () => {
    window.devmonitor.resolveError(key);
    div.classList.add('resolved');
    showToast('VSCode에서 파일을 엽니다...');
  });

  errorList.prepend(div);
  errorElements.set(key, div);
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

// --- Toast ---
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

// --- Clipboard copy notification ---
window.devmonitor.onClipboardCopy(() => {
  showToast('에러가 클립보드에 복사되었습니다');
});

// --- App status ---
window.devmonitor.onAppStatus(({ type, message }) => {
  if (message === 'config-missing') {
    settingsPopup.classList.remove('hidden');
    showToast('설정을 먼저 입력해주세요.');
  } else {
    showToast(message);
  }
});

// --- Servers init (from main process) ---
window.devmonitor.onServersInit((srvList) => {
  servers = srvList;
  if (servers.length > 0 && !activeServerId) {
    activeServerId = servers[0].id;
  }
  renderTabs();
  updateConnectionStatus();
});

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initTerminals();
});
