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
          if (this._initialPath) {
            const cdCmd = process.platform === 'win32'
              ? `cd /d "${this._initialPath}"\r`
              : `cd "${this._initialPath}"\n`;
            this.process.write(cdCmd);
            setTimeout(() => this._launchClaude(), 500);
          } else {
            this._launchClaude();
          }
        }
        break;

      case STATE.SHELL_READY:
        break;

      case STATE.SWITCHING:
        // Waiting for shell prompt after Ctrl+C to exit Claude
        if (this._detectShellPrompt()) {
          this.outputBuffer = '';
          // Now cd to the new path
          const pending = this._pendingSwitch;
          if (pending) {
            this._pendingSwitch = null;
            const cdCmd = process.platform === 'win32'
              ? `cd /d "${pending.localPath}"\r`
              : `cd "${pending.localPath}"\n`;
            this.process.write(cdCmd);
            setTimeout(() => {
              this._launchClaude();
              // After claude is ready, inject the error (handled by queue via processQueue)
            }, 500);
          }
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
    const lines = this.outputBuffer.split('\n');
    const lastLine = lines[lines.length - 1].trim();
    if (process.platform === 'win32') {
      return /[A-Za-z]:\\.*>$/.test(lastLine) || lastLine.endsWith('>');
    }
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
    this.state = STATE.CLAUDE_STARTING;
    this.outputBuffer = '';
    const claudeCmd = process.platform === 'win32' ? 'claude\r' : 'claude\n';
    this.process.write(claudeCmd);

    setTimeout(() => {
      if (this.state === STATE.CLAUDE_STARTING) {
        this.state = STATE.CLAUDE_READY;
        this.outputBuffer = '';
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
    this._pendingSwitch = { localPath: server.local_path };
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
        const pending = this._pendingSwitch;
        if (pending) {
          this._pendingSwitch = null;
          const cdCmd = process.platform === 'win32'
            ? `cd /d "${pending.localPath}"\r`
            : `cd "${pending.localPath}"\n`;
          this.process.write(cdCmd);
          setTimeout(() => this._launchClaude(), 500);
        }
      }
    }, 5000);
  }

  write(data) {
    if (this.process) {
      this.process.write(data);
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
