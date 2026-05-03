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

    // Deploy history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deploy_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deployed_at DATETIME DEFAULT (datetime('now','localtime')),
        server_id TEXT,
        server_name TEXT,
        deploy_mode TEXT,
        os TEXT,
        status TEXT,
        log TEXT
      )
    `);

    // Analysis report table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_report (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        period_start DATETIME,
        period_end DATETIME,
        error_count INTEGER,
        top_errors TEXT,
        claude_analysis TEXT
      )
    `);

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
      unresolve: this.db.prepare(
        'UPDATE error_history SET resolved = 0 WHERE server_id = ? AND error_key = ?'
      ),
      deleteOne: this.db.prepare(
        'DELETE FROM error_history WHERE server_id = ? AND error_key = ?'
      ),
      getAll: this.db.prepare(
        'SELECT * FROM error_history ORDER BY last_seen DESC'
      ),
      getByServer: this.db.prepare(
        'SELECT * FROM error_history WHERE server_id = ? ORDER BY last_seen DESC'
      ),
      getByCompositeKey: this.db.prepare(
        'SELECT * FROM error_history WHERE server_id = ? AND error_key = ?'
      ),
      getUnresolved: this.db.prepare(
        'SELECT * FROM error_history WHERE resolved = 0 ORDER BY last_seen DESC'
      ),
      insertDeploy: this.db.prepare(
        'INSERT INTO deploy_history (server_id, server_name, deploy_mode, os, status, log) VALUES (?, ?, ?, ?, ?, ?)'
      ),
      getAllDeploys: this.db.prepare(
        'SELECT * FROM deploy_history ORDER BY deployed_at DESC LIMIT 100'
      ),
      getRecentErrors: this.db.prepare(
        "SELECT * FROM error_history WHERE last_seen >= datetime('now', 'localtime', ? || ' hours') ORDER BY count DESC"
      ),
      insertReport: this.db.prepare(
        'INSERT INTO analysis_report (period_start, period_end, error_count, top_errors, claude_analysis) VALUES (?, ?, ?, ?, ?)'
      ),
      getAllReports: this.db.prepare(
        'SELECT * FROM analysis_report ORDER BY created_at DESC LIMIT 50'
      ),
      updateReportAnalysis: this.db.prepare(
        'UPDATE analysis_report SET claude_analysis = ? WHERE id = (SELECT MAX(id) FROM analysis_report)'
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

  getByCompositeKey(compositeKey) {
    if (!this.db) return null;
    try {
      const parts = compositeKey.split('::');
      if (parts.length !== 2) return null;
      const [serverId, errorKey] = parts;
      return this.stmts.getByCompositeKey.get(serverId, errorKey) || null;
    } catch (e) {
      console.error('DB getByCompositeKey error:', e.message);
      return null;
    }
  }

  unresolve(serverId, errorKey) {
    if (!this.db) return;
    try { this.stmts.unresolve.run(serverId, errorKey); } catch (e) {}
  }

  deleteOne(serverId, errorKey) {
    if (!this.db) return;
    try { this.stmts.deleteOne.run(serverId, errorKey); } catch (e) {}
  }

  deleteMany(compositeKeys) {
    if (!this.db) return;
    const stmt = this.db.prepare('DELETE FROM error_history WHERE server_id = ? AND error_key = ?');
    const tx = this.db.transaction((keys) => {
      for (const key of keys) {
        const parts = key.split('::');
        if (parts.length === 2) stmt.run(parts[0], parts[1]);
      }
    });
    try { tx(compositeKeys); } catch (e) {}
  }

  deleteAll() {
    if (!this.db) return;
    try { this.db.exec('DELETE FROM error_history'); } catch (e) {}
  }

  insertDeploy(serverId, serverName, deployMode, os, status, log) {
    if (!this.db) return;
    try { this.stmts.insertDeploy.run(serverId, serverName, deployMode, os, status, log); } catch (e) {}
  }

  getAllDeploys() {
    if (!this.db) return [];
    try { return this.stmts.getAllDeploys.all(); } catch (e) { return []; }
  }

  getRecentErrors(hours) {
    if (!this.db) return [];
    try {
      // SQLite datetime modifier needs negative offset: '-24 hours'
      return this.stmts.getRecentErrors.all(`-${hours}`);
    } catch (e) {
      console.error('DB getRecentErrors error:', e.message);
      return [];
    }
  }

  insertReport(periodStart, periodEnd, errorCount, topErrors, claudeAnalysis) {
    if (!this.db) return null;
    try {
      const result = this.stmts.insertReport.run(periodStart, periodEnd, errorCount, topErrors, claudeAnalysis);
      return result.lastInsertRowid;
    } catch (e) {
      console.error('DB insertReport error:', e.message);
      return null;
    }
  }

  getAllReports() {
    if (!this.db) return [];
    try { return this.stmts.getAllReports.all(); } catch (e) { return []; }
  }

  updateReportAnalysis(analysis) {
    if (!this.db) return;
    try { this.stmts.updateReportAnalysis.run(analysis); } catch (e) {}
  }

  // --- 에러 통계 대시보드용 ---
  getStats(modifier) {
    if (!this.db) return null;
    // modifier 화이트리스트 검사
    const allowed = ['-1 day', '-7 days', '-30 days'];
    if (!allowed.includes(modifier)) return null;

    const isHourly = modifier === '-1 day';
    const bucketExpr = isHourly
      ? "strftime('%H', last_seen)"
      : "strftime('%Y-%m-%d', last_seen)";

    try {
      const timeSeries = this.db.prepare(
        `SELECT ${bucketExpr} as bucket, sum(count) as total
         FROM error_history
         WHERE last_seen >= datetime('now', 'localtime', '${modifier}')
         GROUP BY bucket ORDER BY bucket`
      ).all();

      const typeStats = this.db.prepare(
        `SELECT error_type, sum(count) as total
         FROM error_history
         WHERE last_seen >= datetime('now', 'localtime', '${modifier}')
         GROUP BY error_type ORDER BY total DESC LIMIT 8`
      ).all();

      const serverStats = this.db.prepare(
        `SELECT server_name, sum(count) as total
         FROM error_history
         WHERE last_seen >= datetime('now', 'localtime', '${modifier}')
         GROUP BY server_id ORDER BY total DESC`
      ).all();

      const resRows = this.db.prepare(
        `SELECT resolved, sum(count) as total
         FROM error_history
         WHERE last_seen >= datetime('now', 'localtime', '${modifier}')
         GROUP BY resolved`
      ).all();

      const summary = this.db.prepare(
        `SELECT
           count(*) as type_count,
           sum(count) as total_count,
           sum(case when resolved=0 then 1 else 0 end) as unresolved_count,
           sum(case when resolved=1 then 1 else 0 end) as resolved_count,
           count(distinct server_id) as server_count
         FROM error_history
         WHERE last_seen >= datetime('now', 'localtime', '${modifier}')`
      ).get();

      return { timeSeries, typeStats, serverStats, resRows, summary, isHourly };
    } catch (e) {
      console.error('DB getStats error:', e.message);
      return null;
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
