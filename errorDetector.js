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

    // 스택트레이스 수집 상태
    this._collecting = false;
    this._collectBuffer = [];   // ERROR 줄 + 스택트레이스 줄들
    this._collectServerId = null;
    this._collectServerName = null;
    this._collectParsed = null;
  }

  _isStacktraceLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // "at com.xxx", "\tat com.xxx", "Caused by:", "... N more"
    // Java 스택트레이스��� 다양한 형태
    return /^\s*at\s+/.test(line) ||
           /^\t+at\s+/.test(line) ||
           /^Caused by:/.test(trimmed) ||
           /^\.\.\.\s*\d+\s*(more|common frames omitted)/.test(trimmed) ||
           /^\s+at\s+[\w.$]+\(/.test(line) ||
           /^[\w.]+Exception/.test(trimmed) ||
           /^[\w.]+Error:/.test(trimmed);
  }

  _isNewLogLine(line) {
    // 새 타임스탬프 시작 (2026- 형식)
    return /^\d{4}-\d{2}-\d{2}/.test(line.trim());
  }

  _isUserCode(line) {
    // at com. 으로 시작하되 제외 패키지가 아닌 줄만 사용자 코드
    if (!/at\s+com\./.test(line)) return false;
    if (/at\s+(com\.sun\.|com\.oracle\.)/.test(line)) return false;
    return true;
  }

  _filterStacktrace(lines) {
    if (lines.length === 0) return '';

    const errorLine = lines[0]; // ERROR 줄
    const result = [errorLine];

    // 두 번째 줄: 예외 클래스명 + 메시지 (예: java.lang.NullPointerException: ...)
    let startIdx = 1;
    if (lines.length > 1 && /^[\w.]+(?:Exception|Error)/.test(lines[1].trim())) {
      result.push(lines[1].trim());
      startIdx = 2;
    }

    // at 줄 중 사용자 코드(at com.*)만 필터링
    // org.springframework, org.apache, java.base, sun., jdk., jakarta. 는 at com.이 아니라 자동 제외
    const userCodeLines = [];
    for (let i = startIdx; i < lines.length; i++) {
      if (this._isUserCode(lines[i])) {
        userCodeLines.push('    ' + lines[i].trim());
      }
    }

    if (userCodeLines.length > 0) {
      result.push(...userCodeLines);
    } else {
      // fallback: 사용자 코드가 없으면 전체 스택트레이스 앞 5줄
      const fallbackLines = lines.slice(startIdx, startIdx + 5).map(l => '    ' + l.trim());
      result.push(...fallbackLines);
    }

    return result.join('\n');
  }

  _flushCollect() {
    if (!this._collecting || !this._collectParsed) {
      this._collecting = false;
      this._collectBuffer = [];
      return;
    }

    const filteredText = this._filterStacktrace(this._collectBuffer);
    console.log('[ErrorDetector] 전달 블록:', filteredText);
    this._emitError(this._collectParsed, filteredText, this._collectServerId, this._collectServerName);

    this._collecting = false;
    this._collectBuffer = [];
    this._collectParsed = null;
    this._collectServerId = null;
    this._collectServerName = null;
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

    // 스택트레이스 수집 중인 경우
    if (this._collecting) {
      const trimmed = line.trim();
      // 종료 조건: 빈 줄 또는 새 타임스탬프 시작
      if (!trimmed || this._isNewLogLine(line)) {
        this._flushCollect();
        // 빈 줄이면 여기서 끝, 새 로그 줄이면 아래에서 다시 파싱
        if (!trimmed) return null;
      } else if (this._isStacktraceLine(line)) {
        this._collectBuffer.push(line.trim());
        // 스택트레이스 줄이 올 때마다 타이머 리셋
        clearTimeout(this._collectTimer);
        this._collectTimer = setTimeout(() => {
          if (this._collecting) this._flushCollect();
        }, 2000);
        return { collecting: true };
      } else {
        // 스택트레이스도 아니고 빈 줄도 아닌 경우 → 수집 종료
        this._flushCollect();
      }
    }

    // Parse error
    const parsed = this.parseError(line);
    if (!parsed) return null;

    // skipStacktrace: 스택트레이스 수집 없이 바로 emit
    if (parsed.skipStacktrace) {
      const rawText = line.trim();
      console.log('[ErrorDetector] 전달 블록:', rawText);
      this._emitError(parsed, rawText, serverId, serverName);
      return { processed: true };
    }

    // ERROR 줄 감지 → 스택트레이스 수집 시작
    this._collecting = true;
    this._collectBuffer = [line.trim()];
    this._collectServerId = serverId;
    this._collectServerName = serverName;
    this._collectParsed = parsed;

    // 타임아웃: 2초 내 추가 줄이 안 오면 flush (스택트레이스 수집 완료)
    clearTimeout(this._collectTimer);
    this._collectTimer = setTimeout(() => {
      if (this._collecting) this._flushCollect();
    }, 2000);

    return { collecting: true };
  }

  _emitError(parsed, rawText, serverId, serverName) {
    const errorKey = `${parsed.errorType}@${parsed.file}:${parsed.line}`;
    const compositeKey = `${serverId}::${errorKey}`;
    const timestamp = new Date().toISOString();
    const now = Date.now();

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
      return;
    }

    this.lastProcessed.set(compositeKey, now);

    if (this.groups.has(compositeKey)) {
      const group = this.groups.get(compositeKey);
      group.count++;
      group.timestamps.push(timestamp);
      group.lastSeen = timestamp;
      group.rawText = rawText;
      if (this.onUpdateError) this.onUpdateError(compositeKey, group);
    } else {
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
        rawText,
        analysis: null,
        resolved: false
      };
      this.groups.set(compositeKey, group);
      if (this.onNewError) this.onNewError(compositeKey, group);
    }
  }

  parseError(line) {
    if (!line || typeof line !== 'string') return null;

    const cleanLine = line.trim();
    let match;

    // Pattern 0: [FRONTEND] 에러 — 스택트레이스 수집 불필요
    match = cleanLine.match(/\[FRONTEND\]\s+(.+)/);
    if (match) {
      const msg = match[1].trim();
      const firstWord = msg.split(/[\s:(]/)[0] || 'FrontendError';
      return {
        errorType: firstWord,
        file: 'frontend',
        line: '0',
        skipStacktrace: true
      };
    }

    // Pattern 1a: Java Spring Boot log - "ExceptionType at File.java:line"
    match = cleanLine.match(
      /((?:[A-Z]\w*(?:Exception|Error)))\s+at\s+(\w+\.\w+):(\d+)/
    );
    if (match) {
      return {
        errorType: match[1],
        file: match[2],
        line: match[3]
      };
    }

    // Pattern 1b: Java exception with stacktrace location - "at com.pkg.Class.method(File.java:line)"
    match = cleanLine.match(
      /(?:[\w.]*?)((?:[A-Z]\w*(?:Exception|Error)))\b.*?at\s+[\w.$]+\((\w+\.\w+):(\d+)\)/
    );
    if (match && match[1]) {
      return {
        errorType: match[1],
        file: match[2],
        line: match[3]
      };
    }

    // Pattern 2 제거: standalone "at" 줄은 스택트레이스 수집에서만 처리

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
