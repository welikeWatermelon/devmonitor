const { Client } = require('ssh2');
const fs = require('fs');

class SSHManager {
  constructor() {
    // Map<serverId, { logConn, btopConn, logStream, btopStream, backoff, reconnectTimers, status }>
    this.connections = new Map();
    this.disposed = false;

    // Callbacks stored per server
    this._callbacks = new Map(); // serverId -> { onLogData, onBtopData, onStatus }
  }

  _getConnectOptions(server) {
    const opts = {
      host: server.ec2_ip,
      port: server.port || 22,
      username: server.username || 'ec2-user',
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      readyTimeout: 15000
    };
    if (server.pem_key_path) {
      try {
        opts.privateKey = fs.readFileSync(server.pem_key_path);
      } catch (e) {
        console.error(`[${server.id}] PEM 파일 읽기 실패:`, e.message);
      }
    }
    return opts;
  }

  _getBtopConnectOptions(server) {
    const opts = this._getConnectOptions(server);
    if (server.diag_pem_key_path) {
      try {
        opts.privateKey = fs.readFileSync(server.diag_pem_key_path);
      } catch (e) {
        console.error(`[${server.id}] 진단 PEM 읽기 실패:`, e.message);
      }
    }
    return opts;
  }

  _getOrCreateEntry(serverId) {
    if (!this.connections.has(serverId)) {
      this.connections.set(serverId, {
        logConn: null,
        btopConn: null,
        logStream: null,
        btopStream: null,
        backoff: { log: 1000, btop: 1000 },
        reconnectTimers: { log: null, btop: null },
        status: { log: 'disconnected', btop: 'disconnected' }
      });
    }
    return this.connections.get(serverId);
  }

  // --- Connect all servers ---
  connectAll(servers, onLogData, onBtopData, onStatus) {
    for (const server of servers) {
      this.connectServer(server, onLogData, onBtopData, onStatus);
    }
  }

  // --- Connect a single server (both log + btop) ---
  connectServer(server, onLogData, onBtopData, onStatus) {
    if (this.disposed) return;
    this._callbacks.set(server.id, { server, onLogData, onBtopData, onStatus });
    this._connectLog(server);
    this._connectBtop(server);
  }

  // --- Disconnect a single server ---
  disconnectServer(serverId) {
    const entry = this.connections.get(serverId);
    if (!entry) return;
    if (entry.reconnectTimers.log) { clearTimeout(entry.reconnectTimers.log); entry.reconnectTimers.log = null; }
    if (entry.reconnectTimers.btop) { clearTimeout(entry.reconnectTimers.btop); entry.reconnectTimers.btop = null; }
    if (entry.logConn) { try { entry.logConn.end(); } catch (e) {} entry.logConn = null; }
    if (entry.btopConn) { try { entry.btopConn.end(); } catch (e) {} entry.btopConn = null; }
    entry.logStream = null;
    entry.btopStream = null;
    this.connections.delete(serverId);
    this._callbacks.delete(serverId);
  }

  // --- Get status for a server ---
  getStatus(serverId) {
    const entry = this.connections.get(serverId);
    if (!entry) return { log: 'disconnected', btop: 'disconnected' };
    return entry.status;
  }

  // --- Log stream (Sector 2) ---
  _connectLog(server) {
    if (this.disposed) return;
    const entry = this._getOrCreateEntry(server.id);
    const cb = this._callbacks.get(server.id);
    if (!cb) return;

    entry.logConn = new Client();

    entry.logConn.on('ready', () => {
      entry.status.log = 'connected';
      entry.backoff.log = 1000;
      cb.onStatus(server.id, 'log', 'connected');

      const cmd = `tail -F ${server.log_path} 2>&1`;
      entry.logConn.exec(cmd, (err, stream) => {
        if (err) {
          console.error(`[${server.id}] Log exec error:`, err.message);
          entry.status.log = 'error';
          cb.onStatus(server.id, 'log', 'error');
          this._reconnectLog(server.id);
          return;
        }
        entry.logStream = stream;
        stream.on('data', (data) => { cb.onLogData(server.id, data.toString('utf8')); });
        stream.stderr.on('data', (data) => {
          const msg = data.toString('utf8');
          if (msg.includes('No such file') || msg.includes('cannot open')) {
            cb.onLogData(server.id, `\r\n[DevMonitor] 로그 파일을 찾을 수 없습니다: ${server.log_path}\r\n`);
          }
        });
        stream.on('close', () => {
          if (!this.disposed) {
            entry.status.log = 'disconnected';
            cb.onStatus(server.id, 'log', 'disconnected');
            this._reconnectLog(server.id);
          }
        });
      });
    });

    entry.logConn.on('error', (err) => {
      console.error(`[${server.id}] SSH log error:`, err.message);
      entry.status.log = 'error';
      cb.onStatus(server.id, 'log', 'error');
      if (!this.disposed) this._reconnectLog(server.id);
    });

    entry.logConn.on('close', () => {
      if (!this.disposed) {
        entry.status.log = 'disconnected';
        cb.onStatus(server.id, 'log', 'disconnected');
        this._reconnectLog(server.id);
      }
    });

    try {
      entry.logConn.connect(this._getConnectOptions(server));
    } catch (e) {
      console.error(`[${server.id}] SSH log connect error:`, e.message);
      entry.status.log = 'error';
      cb.onStatus(server.id, 'log', 'error');
      this._reconnectLog(server.id);
    }
  }

  _reconnectLog(serverId) {
    if (this.disposed) return;
    const entry = this.connections.get(serverId);
    const cb = this._callbacks.get(serverId);
    if (!entry || !cb) return;
    if (entry.reconnectTimers.log) return;

    const delay = entry.backoff.log;
    entry.status.log = 'reconnecting';
    cb.onStatus(serverId, 'log', 'reconnecting');

    entry.reconnectTimers.log = setTimeout(() => {
      entry.reconnectTimers.log = null;
      entry.backoff.log = Math.min(entry.backoff.log * 2, 30000);
      if (entry.logConn) { try { entry.logConn.end(); } catch (e) {} entry.logConn = null; }
      this._connectLog(cb.server);
    }, delay);
  }

  // --- Btop shell (Sector 3) ---
  _connectBtop(server) {
    if (this.disposed) return;
    const entry = this._getOrCreateEntry(server.id);
    const cb = this._callbacks.get(server.id);
    if (!cb) return;

    entry.btopConn = new Client();

    entry.btopConn.on('ready', () => {
      entry.status.btop = 'connected';
      entry.backoff.btop = 1000;
      cb.onStatus(server.id, 'btop', 'connected');

      entry.btopConn.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, stream) => {
        if (err) {
          console.error(`[${server.id}] btop shell error:`, err.message);
          entry.status.btop = 'error';
          cb.onStatus(server.id, 'btop', 'error');
          this._reconnectBtop(server.id);
          return;
        }
        entry.btopStream = stream;

        stream.on('data', (data) => {
          const text = data.toString('utf8');
          cb.onBtopData(server.id, text);
          if ((text.includes('command not found') || text.includes('not found')) && text.includes('btop')) {
            cb.onBtopData(server.id, '\r\n[DevMonitor] btop이 EC2 서버에 설치되어 있지 않습니다.\r\n');
          }
        });

        stream.on('close', () => {
          entry.btopStream = null;
          if (!this.disposed) {
            entry.status.btop = 'disconnected';
            cb.onStatus(server.id, 'btop', 'disconnected');
            this._reconnectBtop(server.id);
          }
        });

        stream.write('btop\n');

        // btop이 실제로 시작된 후 renderer에 알려서 실제 xterm 크기로 resize할 수 있게 함
        setTimeout(() => {
          if (entry.btopStream && !this.disposed) {
            cb.onStatus(server.id, 'btop', 'btop-ready');
          }
        }, 600);
      });
    });

    entry.btopConn.on('error', (err) => {
      console.error(`[${server.id}] SSH btop error:`, err.message);
      entry.status.btop = 'error';
      cb.onStatus(server.id, 'btop', 'error');
      if (!this.disposed) this._reconnectBtop(server.id);
    });

    entry.btopConn.on('close', () => {
      if (!this.disposed) {
        entry.status.btop = 'disconnected';
        cb.onStatus(server.id, 'btop', 'disconnected');
        this._reconnectBtop(server.id);
      }
    });

    try {
      entry.btopConn.connect(this._getBtopConnectOptions(server));
    } catch (e) {
      console.error(`[${server.id}] SSH btop connect error:`, e.message);
      entry.status.btop = 'error';
      cb.onStatus(server.id, 'btop', 'error');
      this._reconnectBtop(server.id);
    }
  }

  _reconnectBtop(serverId) {
    if (this.disposed) return;
    const entry = this.connections.get(serverId);
    const cb = this._callbacks.get(serverId);
    if (!entry || !cb) return;
    if (entry.reconnectTimers.btop) return;

    const delay = entry.backoff.btop;
    entry.status.btop = 'reconnecting';
    cb.onStatus(serverId, 'btop', 'reconnecting');

    entry.reconnectTimers.btop = setTimeout(() => {
      entry.reconnectTimers.btop = null;
      entry.backoff.btop = Math.min(entry.backoff.btop * 2, 30000);
      if (entry.btopConn) { try { entry.btopConn.end(); } catch (e) {} entry.btopConn = null; }
      this._connectBtop(cb.server);
    }, delay);
  }

  // --- btop interaction ---
  writeBtop(serverId, data) {
    const entry = this.connections.get(serverId);
    if (entry && entry.btopStream) entry.btopStream.write(data);
  }

  resizeBtop(serverId, cols, rows) {
    const entry = this.connections.get(serverId);
    if (entry && entry.btopStream) entry.btopStream.setWindow(rows, cols, 0, 0);
  }

  diagExec(serverId, command, callback) {
    const entry = this.connections.get(serverId);
    if (!entry || !entry.btopConn) {
      callback(null, '[DevMonitor] 서버에 연결되지 않았습니다.');
      return;
    }
    entry.btopConn.exec(command, (err, stream) => {
      if (err) { callback(null, err.message); return; }
      let out = '';
      stream.on('data', d => out += d.toString('utf8'));
      stream.stderr.on('data', d => out += d.toString('utf8'));
      stream.on('close', () => callback(out, null));
    });
  }

  // --- SFTP file upload (replaces external scp, avoids Windows path escaping issues) ---
  sftpUpload(server, localPath, remotePath, onProgress) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const opts = this._getConnectOptions(server);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { conn.end(); return reject(err); }

          const readStream = fs.createReadStream(localPath);
          const writeStream = sftp.createWriteStream(remotePath);

          readStream.on('error', (e) => { conn.end(); reject(e); });
          writeStream.on('error', (e) => { conn.end(); reject(e); });

          writeStream.on('close', () => {
            conn.end();
            resolve();
          });

          if (onProgress) {
            try {
              const total = fs.statSync(localPath).size;
              let transferred = 0;
              readStream.on('data', (chunk) => {
                transferred += chunk.length;
                onProgress(transferred, total);
              });
            } catch (e) { /* stat 실패 시 progress 무시 */ }
          }

          readStream.pipe(writeStream);
        });
      });

      conn.on('error', reject);
      conn.connect(opts);
    });
  }

  // --- Cleanup ---
  dispose() {
    this.disposed = true;
    for (const [serverId] of this.connections) {
      this.disconnectServer(serverId);
    }
    this.connections.clear();
    this._callbacks.clear();
  }
}

module.exports = SSHManager;
