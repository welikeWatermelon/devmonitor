const os = require('os');
const path = require('path');

const STATE = {
  SHELL_STARTING: 'SHELL_STARTING',
  SHELL_READY: 'SHELL_READY',
  CLAUDE_STARTING: 'CLAUDE_STARTING',
  CLAUDE_READY: 'CLAUDE_READY',
  CLAUDE_BUSY: 'CLAUDE_BUSY',
  SWITCHING: 'SWITCHING'
};

class PtyManager {
  constructor() {
    this.process = null;
    this.state = STATE.SHELL_STARTING;
    this.outputBuffer = '';
    this.commandQueue = [];
    this.onDataCallback = null;
    this.onAnalysisCallback = null;
    this.analysisBuffer = '';
    this.currentErrorKey = null;
    this.activeClaudeServerId = null;
    this._initialPath = null;
  }

  start(initialPath, onData) {
    let pty;
    try {
      pty = require('node-pty');
    } catch (e) {
      console.error('node-pty 로드 실패:', e.message);
      onData('\r\n[DevMonitor] node-pty를 로드할 수 없습니다.\r\n');
      onData('[DevMonitor] npm rebuild node-pty 또는 npx electron-rebuild\r\n');
      return;
    }

    this.onDataCallback = onData;
    this._initialPath = initialPath;
    this.state = STATE.SHELL_STARTING;

    const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');

    this.process = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: initialPath || os.homedir(),
      env: { ...process.env },
      encoding: 'utf8'
    });

    this.process.onData((data) => {
      onData(data);
      this._handleOutput(data);
    });

    // 타임아웃 폴백: 3초 내 프롬프트 감지 실패 시 강제로 claude 실행
    this._shellPromptTimeout = setTimeout(() => {
      if (this.state === STATE.SHELL_STARTING) {
        console.log('[PTY] 프롬프트 감지 타임아웃, 강제로 claude 실행');
        this.state = STATE.SHELL_READY;
        this.outputBuffer = '';
        this._launchClaude();
      }
    }, 3000);

    this.process.onExit(({ exitCode }) => {
      console.log('PTY process exited with code:', exitCode);
      onData(`\r\n[DevMonitor] 터미널 프로세스가 종료되었습니다 (코드: ${exitCode})\r\n`);
    });
  }

  _handleOutput(data) {
    this.outputBuffer += data;
    if (this.outputBuffer.length > 10000) {
      this.outputBuffer = this.outputBuffer.slice(-5000);
    }

    switch (this.state) {
      case STATE.SHELL_STARTING:
        if (this._detectShellPrompt()) {
          this.state = STATE.SHELL_READY;
          this.outputBuffer = '';
          // cwd로 이미 설정되어 있으므로 cd 불필요, 1.5초 후 claude 실행
          setTimeout(() => this._launchClaude(), 1500);
        }
        break;

      case STATE.SHELL_READY:
        break;

      case STATE.SWITCHING:
        // Waiting for shell prompt after Ctrl+C to exit Claude
        if (this._detectShellPrompt()) {
          this.outputBuffer = '';
          // cd 불필요 — 항상 project_path에서 실행
          this._pendingSwitch = null;
          setTimeout(() => this._launchClaude(), 500);
        }
        break;

      case STATE.CLAUDE_STARTING:
        if (this._detectClaudePrompt()) {
          this.state = STATE.CLAUDE_READY;
          this.outputBuffer = '';
          this._processQueue();
        }
        break;

      case STATE.CLAUDE_READY:
        break;

      case STATE.CLAUDE_BUSY:
        this.analysisBuffer += data;
        if (this._detectClaudePrompt()) {
          this.state = STATE.CLAUDE_READY;
          if (this.currentErrorKey && this.onAnalysisCallback) {
            const analysis = this._extractAnalysis(this.analysisBuffer);
            this.onAnalysisCallback(this.currentErrorKey, analysis);
          }
          this.analysisBuffer = '';
          this.currentErrorKey = null;
          this.outputBuffer = '';
          this._processQueue();
        }
        break;
    }
  }

  _detectShellPrompt() {
    // ANSI 이스케이프 코드 제거
    const clean = this.outputBuffer.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = clean.split('\n');

    if (process.platform === 'win32') {
      // lastLine 검사
      const lastLine = lines[lines.length - 1].trim();
      if (/[A-Za-z]:\\.*>/.test(lastLine) || lastLine.endsWith('>')) {
        return true;
      }
      // outputBuffer 전체에서 '>' 포함 줄 검사 (프롬프트가 중간에 있을 수 있음)
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        const l = lines[i].trim();
        if (/[A-Za-z]:\\.*>/.test(l) || (l.length > 1 && l.endsWith('>'))) {
          return true;
        }
      }
      return false;
    }
    const lastLine = lines[lines.length - 1].trim();
    return /[$#]\s*$/.test(lastLine);
  }

  _detectClaudePrompt() {
    const lines = this.outputBuffer.split('\n');
    const lastLines = lines.slice(-3).join('\n');
    return /^>\s*$/m.test(lastLines) ||
           /\$\s*$/.test(lastLines) ||
           /❯\s*$/.test(lastLines);
  }

  _launchClaude() {
    console.log('[PTY] launching claude...');
    if (this._shellPromptTimeout) {
      clearTimeout(this._shellPromptTimeout);
      this._shellPromptTimeout = null;
    }
    this.state = STATE.CLAUDE_STARTING;
    this.outputBuffer = '';
    const claudeCmd = process.platform === 'win32' ? 'claude\r' : 'claude\n';
    this.process.write(claudeCmd);

    setTimeout(() => {
      if (this.state === STATE.CLAUDE_STARTING) {
        this.state = STATE.CLAUDE_READY;
        this.outputBuffer = '';
        this._processQueue();
      }
    }, 10000);
  }

  // --- Context switching for multi-server ---
  switchContext(server, errorText, errorKey) {
    if (!this.process) return;

    if (this.activeClaudeServerId === server.id) {
      // Same server: inject directly (or queue if busy)
      this.injectCommand(errorText, errorKey);
      return;
    }

    // Different server: need to exit claude, cd, restart claude
    this.activeClaudeServerId = server.id;

    if (this.state === STATE.CLAUDE_BUSY) {
      // Queue the switch for after current operation completes
      this.commandQueue.push({ text: errorText, errorKey, switchTo: server });
      return;
    }

    this._performSwitch(server, errorText, errorKey);
  }

  _performSwitch(server, errorText, errorKey) {
    // Queue the error text for injection after claude restarts
    if (errorText) {
      this.commandQueue.unshift({ text: errorText, errorKey });
    }

    // Send Ctrl+C twice to exit Claude
    this.state = STATE.SWITCHING;
    this.outputBuffer = '';
    this._pendingSwitch = true;
    this.process.write('\x03');
    setTimeout(() => {
      if (this.state === STATE.SWITCHING) {
        this.process.write('\x03');
      }
    }, 300);

    // Fallback: if shell prompt not detected within 5s, force state
    setTimeout(() => {
      if (this.state === STATE.SWITCHING) {
        this.outputBuffer = '';
        this._pendingSwitch = null;
        this._launchClaude();
      }
    }, 5000);
  }

  write(data) {
    if (this.process) {
      this.process.write(data);
    }
  }

  injectWithoutEnter(text) {
    if (this.state === STATE.CLAUDE_READY) {
      if (this.process) this.process.write(text);
    } else {
      this.commandQueue.push({ text, noEnter: true });
    }
  }

  injectCommand(text, errorKey) {
    if (this.state === STATE.CLAUDE_READY) {
      this._executeInjection(text, errorKey);
    } else {
      this.commandQueue.push({ text, errorKey });
    }
  }

  _executeInjection(text, errorKey) {
    if (!this.process) return;

    this.state = STATE.CLAUDE_BUSY;
    this.currentErrorKey = errorKey;
    this.analysisBuffer = '';
    this.outputBuffer = '';

    const cmd = text + (process.platform === 'win32' ? '\r' : '\n');
    this.process.write(cmd);
  }

  _processQueue() {
    if (this.commandQueue.length === 0 || this.state !== STATE.CLAUDE_READY) return;

    const next = this.commandQueue.shift();

    // Check if this queued item requires a context switch
    if (next.switchTo) {
      this.activeClaudeServerId = next.switchTo.id;
      this._performSwitch(next.switchTo, next.text, next.errorKey);
      return;
    }

    // noEnter: 텍스트만 입력, 엔터 없음
    if (next.noEnter) {
      if (this.process) this.process.write(next.text);
      return;
    }

    this._executeInjection(next.text, next.errorKey);
  }

  _extractAnalysis(rawOutput) {
    let stripAnsi;
    try {
      stripAnsi = require('strip-ansi');
    } catch (e) {
      stripAnsi = (str) => str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    }

    const clean = stripAnsi(rawOutput);
    const lines = clean.split('\n').filter(l => l.trim().length > 0);
    const analysisLines = lines.slice(1, -1);

    const summary = analysisLines
      .filter(l => l.trim().length > 10)
      .slice(0, 5)
      .join('\n')
      .trim();

    return summary || '분석 결과를 파싱할 수 없습니다.';
  }

  setAnalysisCallback(cb) {
    this.onAnalysisCallback = cb;
  }

  resize(cols, rows) {
    if (this.process) this.process.resize(cols, rows);
  }

  dispose() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

module.exports = PtyManager;
