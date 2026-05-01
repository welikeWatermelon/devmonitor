const path = require('path');

class ErrorDB {
  constructor(dbPath) {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (e) {
      console.error('better-sqlite3 로드 실패:', e.message);
      this.db = null;
      return;
    }

    this.db = new Database(dbPath || path.join(__dirname, 'errorHistory.db'));
    this.init();
  }

  init() {
    if (!this.db) return;

    // Check if old schema exists (without server_id) and migrate
    const tableInfo = this.db.pragma('table_info(error_history)');
    const hasServerId = tableInfo.some(col => col.name === 'server_id');

    if (tableInfo.length > 0 && !hasServerId) {
      // Migrate: add server_id and server_name to existing table
      this.db.exec(`ALTER TABLE error_history ADD COLUMN server_id TEXT NOT NULL DEFAULT 'legacy'`);
      this.db.exec(`ALTER TABLE error_history ADD COLUMN server_name TEXT NOT NULL DEFAULT 'legacy'`);
      // Drop old unique index and create new composite one
      this.db.exec(`DROP INDEX IF EXISTS idx_error_key`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_server_error_key ON error_history(server_id, error_key)`);
    } else if (tableInfo.length === 0) {
      // Fresh table with new schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS error_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id TEXT NOT NULL,
          server_name TEXT NOT NULL,
          error_key TEXT NOT NULL,
          error_type TEXT NOT NULL,
          file_location TEXT,
          first_seen DATETIME DEFAULT (datetime('now','localtime')),
          last_seen DATETIME DEFAULT (datetime('now','localtime')),
          count INTEGER DEFAULT 1,
          analysis TEXT,
          resolved INTEGER DEFAULT 0
        )
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_server_error_key ON error_history(server_id, error_key)
      `);
    }

    // Prepare statements
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO error_history (server_id, server_name, error_key, error_type, file_location, first_seen, last_seen, count)
        VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'), 1)
        ON CONFLICT(server_id, error_key) DO UPDATE SET
          last_seen = datetime('now','localtime'),
          count = count + 1
      `),
      updateAnalysis: this.db.prepare(
        'UPDATE error_history SET analysis = ? WHERE server_id = ? AND error_key = ?'
      ),
      updateCount: this.db.prepare(
        "UPDATE error_history SET count = count + 1, last_seen = datetime('now','localtime') WHERE server_id = ? AND error_key = ?"
      ),
      resolve: this.db.prepare(
        'UPDATE error_history SET resolved = 1 WHERE server_id = ? AND error_key = ?'
      ),
      getAll: this.db.prepare(
        'SELECT * FROM error_history ORDER BY last_seen DESC'
      ),
      getByServer: this.db.prepare(
        'SELECT * FROM error_history WHERE server_id = ? ORDER BY last_seen DESC'
      ),
      getUnresolved: this.db.prepare(
        'SELECT * FROM error_history WHERE resolved = 0 ORDER BY last_seen DESC'
      )
    };
  }

  upsert(serverId, serverName, errorKey, errorType, fileLocation) {
    if (!this.db) return;
    try {
      this.stmts.upsert.run(serverId, serverName, errorKey, errorType, fileLocation);
    } catch (e) {
      console.error('DB upsert error:', e.message);
    }
  }

  updateAnalysis(serverId, errorKey, analysis) {
    if (!this.db) return;
    try {
      this.stmts.updateAnalysis.run(analysis, serverId, errorKey);
    } catch (e) {
      console.error('DB updateAnalysis error:', e.message);
    }
  }

  updateCount(serverId, errorKey) {
    if (!this.db) return;
    try {
      this.stmts.updateCount.run(serverId, errorKey);
    } catch (e) {
      console.error('DB updateCount error:', e.message);
    }
  }

  resolve(serverId, errorKey) {
    if (!this.db) return;
    try {
      this.stmts.resolve.run(serverId, errorKey);
    } catch (e) {
      console.error('DB resolve error:', e.message);
    }
  }

  getAll() {
    if (!this.db) return [];
    try {
      return this.stmts.getAll.all();
    } catch (e) {
      console.error('DB getAll error:', e.message);
      return [];
    }
  }

  getByServer(serverId) {
    if (!this.db) return [];
    try {
      return this.stmts.getByServer.all(serverId);
    } catch (e) {
      console.error('DB getByServer error:', e.message);
      return [];
    }
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (e) {}
      this.db = null;
    }
  }
}

module.exports = ErrorDB;
