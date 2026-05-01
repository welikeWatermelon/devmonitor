class ErrorDetector {
  constructor(onNewError, onUpdateError, onFloodWarning) {
    this.groups = new Map();        // compositeKey -> group data
    this.lastProcessed = new Map(); // compositeKey -> timestamp (debounce)
    this.rateCounter = 0;
    this.rateWindowStart = Date.now();
    this.onNewError = onNewError;
    this.onUpdateError = onUpdateError;
    this.onFloodWarning = onFloodWarning;
    this.floodWarned = false;
  }

  processLine(line, serverId, serverName) {
    const now = Date.now();

    // Rate limit: max 10 per second
    if (now - this.rateWindowStart > 1000) {
      this.rateCounter = 0;
      this.rateWindowStart = now;
      this.floodWarned = false;
    }

    if (this.rateCounter >= 10) {
      if (!this.floodWarned && this.onFloodWarning) {
        this.onFloodWarning();
        this.floodWarned = true;
      }
      return { dropped: true };
    }
    this.rateCounter++;

    // Parse error
    const parsed = this.parseError(line);
    if (!parsed) return null;

    const errorKey = `${parsed.errorType}@${parsed.file}:${parsed.line}`;
    // Composite key includes serverId so same error on different servers are separate
    const compositeKey = `${serverId}::${errorKey}`;
    const timestamp = new Date().toISOString();

    // Debounce: same error group within 30s
    const lastTime = this.lastProcessed.get(compositeKey);
    if (lastTime && (now - lastTime) < 30000) {
      const group = this.groups.get(compositeKey);
      if (group) {
        group.count++;
        group.timestamps.push(timestamp);
        group.lastSeen = timestamp;
        if (this.onUpdateError) this.onUpdateError(compositeKey, group);
      }
      return { debounced: true, key: compositeKey };
    }

    this.lastProcessed.set(compositeKey, now);

    if (this.groups.has(compositeKey)) {
      // Existing group, non-debounced recurrence - update only, no new notification
      const group = this.groups.get(compositeKey);
      group.count++;
      group.timestamps.push(timestamp);
      group.lastSeen = timestamp;
      if (this.onUpdateError) this.onUpdateError(compositeKey, group);
    } else {
      // New error group
      const group = {
        serverId,
        serverName: serverName || serverId,
        errorKey,
        errorType: parsed.errorType,
        file: parsed.file,
        line: parsed.line,
        timestamps: [timestamp],
        count: 1,
        firstSeen: timestamp,
        lastSeen: timestamp,
        rawText: line.trim(),
        analysis: null,
        resolved: false
      };
      this.groups.set(compositeKey, group);
      if (this.onNewError) this.onNewError(compositeKey, group);
    }

    return { processed: true, key: compositeKey };
  }

  parseError(line) {
    if (!line || typeof line !== 'string') return null;

    const cleanLine = line.trim();
    let match;

    // Pattern 1: Java exception with file location
    match = cleanLine.match(
      /(?:[\w.]*?)((?:[A-Z]\w*(?:Exception|Error)))\b.*?(?:at\s+[\w.$]+\((\w+\.\w+):(\d+)\))?/
    );
    if (match && match[1]) {
      return {
        errorType: match[1],
        file: match[2] || 'unknown',
        line: match[3] || '0'
      };
    }

    // Pattern 2: Java "at" line standalone
    match = cleanLine.match(/at\s+[\w.$]+\((\w+\.\w+):(\d+)\)/);
    if (match) {
      const excMatch = cleanLine.match(/((?:[A-Z]\w*(?:Exception|Error)))/);
      return {
        errorType: excMatch ? excMatch[1] : 'UnknownException',
        file: match[1],
        line: match[2]
      };
    }

    // Pattern 3: Python traceback
    match = cleanLine.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
    if (match) {
      const fileName = match[1].split(/[/\\]/).pop();
      return { errorType: 'PythonError', file: fileName, line: match[2] };
    }

    // Pattern 4: Node.js/JavaScript error
    match = cleanLine.match(/at\s+.*?\((.+?):(\d+):\d+\)/);
    if (match) {
      const fileName = match[1].split(/[/\\]/).pop();
      const errMatch = cleanLine.match(/((?:[A-Z]\w*(?:Error|Exception)))/);
      return {
        errorType: errMatch ? errMatch[1] : 'RuntimeError',
        file: fileName,
        line: match[2]
      };
    }

    // Pattern 5: Generic ERROR line with file:line
    match = cleanLine.match(/\bERROR\b.*?(\w+\.\w+):(\d+)/);
    if (match) {
      return { errorType: 'ERROR', file: match[1], line: match[2] };
    }

    // Pattern 6: Any line with ERROR keyword (fallback)
    if (/\bERROR\b/i.test(cleanLine)) {
      return { errorType: 'ERROR', file: 'unknown', line: '0' };
    }

    return null;
  }
}

module.exports = ErrorDetector;
