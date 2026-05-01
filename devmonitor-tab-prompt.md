# DevMonitor 탭 기능 추가 프롬프트

## 목적

현재 단일 서버만 지원하는 DevMonitor에 **다중 서버 탭 기능**을 추가한다.
섹터 2(서버 로그)와 섹터 3(서버 현황)에 탭을 붙여 여러 서버를 전환하며 모니터링할 수 있게 한다.

---

## 현재 구조 (변경 전)

```json
// config.json (현재)
{
  "pem_key_path": "...",
  "ec2_ip": "...",
  "username": "ec2-user",
  "port": 22,
  "log_path": "/home/ec2-user/app/logs/spring.log",
  "project_path": "C:/Users/.../my-spring-app"
}
```

---

## 변경 후 구조

### config.json — servers 배열로 변경, project_path 제거

```json
{
  "servers": [
    {
      "id": "backend",
      "name": "백엔드",
      "pem_key_path": "C:/Users/.../backend.pem",
      "ec2_ip": "13.125.xxx.xxx",
      "username": "ec2-user",
      "port": 22,
      "log_path": "/home/ec2-user/app/logs/spring.log",
      "local_path": "C:/Users/.../my-project/backend"
    },
    {
      "id": "frontend",
      "name": "프론트",
      "pem_key_path": "C:/Users/.../frontend.pem",
      "ec2_ip": "13.125.yyy.yyy",
      "username": "ubuntu",
      "port": 22,
      "log_path": "/home/ubuntu/app/logs/frontend.log",
      "local_path": "C:/Users/.../my-project/frontend"
    }
  ]
}
```

- `id`: 고유 식별자 (영문 소문자, 하이픈 허용)
- `name`: 탭에 표시될 이름 (한글 가능)
- `local_path`: 해당 서버의 로컬 프로젝트 디렉터리 경로 (에러 발생 시 Claude Code가 이 경로로 이동)
- 기존 최상위 `project_path`는 **완전히 제거**한다
- 서버는 최소 1개, 최대 제한 없음

---

## UI 변경 사항

### 섹터 2 — 서버 로그 탭

```
┌─────────────────────────────────────────┐
│ [백엔드 ●] [프론트 ●] [+]               │  ← 탭 바
├─────────────────────────────────────────┤
│ 14:23:45 ERROR NullPointerException     │
│ 14:24:31 ERROR NullPointerException     │  ← 선택된 탭의 로그
└─────────────────────────────────────────┘
```

### 섹터 3 — 서버 현황 탭

```
┌─────────────────────────────────────────┐
│ [백엔드 ●] [프론트 ●] [+]               │  ← 탭 바 (섹터 2와 동일)
├─────────────────────────────────────────┤
│ CPU  ████░░░ 42%                        │
│ MEM  ███████ 67%                        │  ← 선택된 탭의 btop
└─────────────────────────────────────────┘
```

### 탭 상태 표시
- `●` 초록: SSH 연결됨
- `●` 빨강: SSH 끊김 또는 재연결 중
- `●` 노랑: 재연결 시도 중

### [+] 버튼
- 클릭 시 설정 팝업을 열지 않고, **탭 바 바로 아래에 아코디언(인라인 폼)으로 펼쳐진다**
- 이미 폼이 열려있으면 닫힌다 (토글)

### 탭 동기화
- 섹터 2와 섹터 3의 탭은 항상 같은 서버를 가리킨다
- 섹터 2 탭 클릭 시 섹터 3도 같은 탭으로 전환됨

---

## 에러 감지 시 섹터 1 동작 (PTY 로직 변경)

에러가 감지된 서버에 따라 Claude Code를 실행할 디렉터리를 다르게 설정한다.

```javascript
// 에러 감지 시 해당 서버의 local_path로 이동 후 claude 실행
function handleError(serverId, errorText) {
  const server = config.servers.find(s => s.id === serverId);
  const localPath = server.local_path;

  // 현재 섹터 1이 CLAUDE_READY 상태일 때
  ptyManager.switchContext(localPath, errorText);
}

// pty.js 내 switchContext
// 1. 현재 Claude 세션을 종료 (Ctrl+C)
// 2. cd {localPath} 실행
// 3. claude 재실행
// 4. CLAUDE_READY 감지 후 에러 텍스트 주입
```

**동작 흐름:**
```
백엔드 에러 감지
    ↓
server.local_path = "C:/Users/.../my-project/backend"
    ↓
섹터 1: cd C:/Users/.../my-project/backend
    ↓
claude 실행 → CLAUDE_READY 감지
    ↓
에러 텍스트 자동 주입 (모드 B) 또는 클립보드 복사 (모드 A)
```

**컨텍스트 전환 시 주의사항:**
- Claude가 응답 중(`CLAUDE_BUSY`)이면 큐에 적재 후 `CLAUDE_READY`가 되었을 때 처리
- 같은 서버의 연속 에러는 claude를 재시작하지 않고 바로 텍스트 주입
- 다른 서버로 전환 시에만 `cd + claude 재시작` 수행
- 현재 활성 서버 ID를 `activeClaudeServerId`로 pty.js에서 추적

---

## 에러 분석 로그 변경

에러 그룹에 서버 이름 라벨 추가:

```
[백엔드] NullPointerException @ UserService.java:142
  14:23:45  14:24:31  14:25:01
  user 객체 null 체크 누락으로 추정
  [해결하기]

[프론트] TypeError: Cannot read property 'map'
  15:10:22
  [해결하기]
```

---

## 설정 팝업 변경

### 서버 목록 표시

```
설정
┌─────────────────────────────────┐
│ 서버 목록                        │
│ ┌───────────────────────────┐   │
│ │ 백엔드  13.125.xxx.xxx  [수정] [삭제] │
│ │ 프론트  13.125.yyy.yyy  [수정] [삭제] │
│ └───────────────────────────┘   │
│ [+ 서버 추가 ▼]                  │  ← 클릭 시 아코디언으로 인라인 폼 펼침
│                                  │
│ ┌ 아코디언 폼 (펼쳐진 상태) ──┐  │
│ │ 서버 이름  [           ]   │  │
│ │ PEM 경로  [           ]   │  │
│ │ EC2 IP    [           ]   │  │
│ │ 사용자명  [           ]   │  │
│ │ 포트      [22         ]   │  │
│ │ 로그 경로 [           ]   │  │
│ │ 로컬 경로 [           ]   │  │  ← local_path 입력
│ │           [취소] [추가]   │  │
│ └───────────────────────────┘  │
│                                  │
│ [저장]                           │
└─────────────────────────────────┘
```

- `[+ 서버 추가 ▼]` 버튼 클릭 → 바로 아래 인라인 폼이 슬라이드 다운
- 이미 열려있으면 `▲`로 전환되고 폼이 닫힘
- `[수정]` 클릭 시 해당 서버 행이 인라인 폼으로 교체됨 (같은 아코디언 패턴)
- 팝업을 새로 띄우지 않음 — 모든 편집이 같은 설정 팝업 안에서 이루어짐

### 서버 목록 — [수정] 인라인 폼

```
│ ┌ 수정 중: 백엔드 ─────────┐  │
│ │ 서버 이름  [백엔드      ] │  │
│ │ PEM 경로  [C:/...pem   ] │  │
│ │ EC2 IP    [13.125.xxx  ] │  │
│ │ 사용자명  [ec2-user    ] │  │
│ │ 포트      [22          ] │  │
│ │ 로그 경로 [/home/...   ] │  │
│ │ 로컬 경로 [C:/...back  ] │  │
│ │           [취소] [저장] │  │
│ └───────────────────────┘  │
```

---

## 변경이 필요한 파일

### 1. config.json 마이그레이션
기존 단일 서버 형식의 config.json이 있을 경우 자동으로 servers 배열 형식으로 변환한다.

```javascript
// 마이그레이션 로직 (main.js 또는 별도 migrate.js)
if (config.ec2_ip && !config.servers) {
  config.servers = [{
    id: 'server1',
    name: '서버 1',
    pem_key_path: config.pem_key_path,
    ec2_ip: config.ec2_ip,
    username: config.username,
    port: config.port,
    log_path: config.log_path,
    local_path: config.project_path || ''   // project_path → local_path 이전
  }];
  // 구 필드 전부 삭제
  delete config.pem_key_path;
  delete config.ec2_ip;
  delete config.username;
  delete config.port;
  delete config.log_path;
  delete config.project_path;
}
```

### 2. ssh.js — 다중 서버 연결 관리

```javascript
// 서버별 SSH 연결 Map으로 관리
const connections = new Map();
// connections.get(serverId) => { logConn, btopConn, logStream, btopStream, status, backoff }

// 주요 함수
connectServer(server)       // 특정 서버에 SSH 연결 (로그 + btop)
disconnectServer(serverId)  // 특정 서버 연결 해제
connectAll(servers)         // 모든 서버 동시 연결
reconnect(serverId)         // Exponential Backoff 재연결
getStatus(serverId)         // 연결 상태 반환
```

- 모든 서버의 로그 스트림은 항상 읽어서 errorDetector에 전달 (탭 선택 여부 무관)
- UI 표시는 현재 선택된 탭의 스트림만 xterm.js에 렌더링

### 3. errorDetector.js — server_id 추가

```javascript
// 에러 이벤트에 serverId 포함
{
  serverId: 'backend',
  serverName: '백엔드',
  errorKey: 'NullPointerException@UserService.java:142',
  errorType: 'NullPointerException',
  fileLocation: 'UserService.java:142',
  rawLog: '...',
  timestamp: '2024-05-02T14:23:45'
}
```

### 4. db.js — server_id 컬럼 추가

```sql
CREATE TABLE error_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,          -- 추가
  server_name TEXT NOT NULL,        -- 추가
  error_key TEXT NOT NULL,
  error_type TEXT NOT NULL,
  file_location TEXT,
  first_seen DATETIME,
  last_seen DATETIME,
  count INTEGER DEFAULT 1,
  analysis TEXT,
  resolved INTEGER DEFAULT 0,
  UNIQUE(server_id, error_key)      -- server_id 포함 복합 유니크
);
```

### 5. pty.js — 서버별 local_path 컨텍스트 전환

```javascript
let activeClaudeServerId = null;

async function switchContext(server, errorText, mode) {
  if (activeClaudeServerId === server.id) {
    // 같은 서버 → 재시작 없이 바로 에러 주입
    injectError(errorText, mode);
    return;
  }

  // 다른 서버로 전환
  activeClaudeServerId = server.id;

  // 1. 현재 Claude 세션 종료 (Ctrl+C 두 번)
  pty.write('\x03\x03');
  await waitForPrompt();

  // 2. 해당 서버의 로컬 경로로 이동
  pty.write(`cd "${server.local_path}"\r`);
  await waitForPrompt();

  // 3. claude 재실행
  pty.write('claude\r');
  await waitForClaudeReady();

  // 4. 에러 주입
  injectError(errorText, mode);
}
```

### 6. index.html — 탭 UI 추가

섹터 2, 3 헤더 영역에 탭 바 삽입:

```html
<!-- 섹터 2 -->
<div class="sector-header">
  <div class="tab-bar" id="log-tab-bar">
    <!-- JS로 동적 생성 -->
  </div>
  <!-- [+] 클릭 시 아코디언 폼 -->
  <div class="tab-add-form" id="tab-add-form" style="display:none;">
    <!-- 인라인 서버 추가 폼 -->
  </div>
</div>

<!-- 섹터 3 -->
<div class="sector-header">
  <div class="tab-bar" id="btop-tab-bar">
    <!-- JS로 동적 생성 -->
  </div>
</div>
```

### 7. style.css — 탭 스타일

```css
.tab-bar { display: flex; align-items: center; gap: 4px; }
.tab { padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
.tab.active { background: rgba(255,255,255,0.15); }
.tab .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; }
.tab-add { padding: 2px 8px; opacity: 0.5; cursor: pointer; }
.tab-add:hover { opacity: 1; }

/* 아코디언 서버 추가 폼 */
.tab-add-form {
  overflow: hidden;
  max-height: 0;
  transition: max-height 0.2s ease;
  background: rgba(255,255,255,0.05);
  border-radius: 4px;
  margin-top: 4px;
}
.tab-add-form.open { max-height: 300px; }
.tab-add-form input {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  color: inherit;
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 11px;
  width: 100%;
}
```

### 8. renderer.js — 탭 전환 로직

```javascript
let activeServerId = null;

function switchTab(serverId) {
  activeServerId = serverId;
  // 섹터 2, 3 탭 동시 전환
  updateTabUI('log-tab-bar', serverId);
  updateTabUI('btop-tab-bar', serverId);
  // 해당 서버 스트림을 xterm에 연결
  window.api.switchLogDisplay(serverId);
  window.api.switchBtopDisplay(serverId);
}

function renderTabBar(tabBarId, servers, activeId) {
  const bar = document.getElementById(tabBarId);
  bar.innerHTML = servers.map(s => `
    <div class="tab ${s.id === activeId ? 'active' : ''}" onclick="switchTab('${s.id}')">
      <span class="dot" style="background:${getStatusColor(s.id)}"></span>
      ${s.name}
    </div>
  `).join('') + '<div class="tab-add" onclick="toggleAddForm()">+</div>';
}

function toggleAddForm() {
  const form = document.getElementById('tab-add-form');
  form.classList.toggle('open');
}
```

### 9. main.js — IPC 채널 수정

추가되는 IPC 채널:
- `tab:switch` — 탭 전환 (serverId 전달)
- `server:add` — 서버 추가
- `server:update` — 서버 수정
- `server:delete` — 서버 삭제 (SSH 종료 → config 제거 순서 준수)
- `server:status` — 특정 서버 연결 상태 (기존 ssh:status 확장)

### 10. preload.js — 새 IPC 채널 노출

위 9번의 새 채널들을 contextBridge에 추가한다.

---

## 구현 순서

1. config.json 마이그레이션 로직 (기존 단일 서버 → servers 배열 자동 변환, project_path → local_path)
2. ssh.js 다중 서버 Map 구조로 리팩토링
3. errorDetector.js에 serverId 추가
4. db.js server_id 컬럼 추가 (기존 DB 마이그레이션 포함)
5. pty.js switchContext 로직 추가 (서버별 local_path 기반 cd + claude 재시작)
6. index.html 탭 바 HTML 구조 추가 (아코디언 폼 포함)
7. style.css 탭 스타일 + 아코디언 애니메이션 추가
8. renderer.js 탭 렌더링 + 전환 로직 + 아코디언 토글
9. main.js / preload.js IPC 채널 추가
10. 설정 팝업 서버 목록 + 아코디언 추가/수정/삭제 UI

---

## 주의사항

- 모든 서버의 로그는 탭 선택 여부와 무관하게 항상 수신한다 (에러 감지는 백그라운드에서 계속)
- UI 렌더링은 현재 선택된 탭 서버만 xterm.js에 표시한다
- 서버 삭제 시 해당 서버의 SSH 연결을 먼저 종료 후 config에서 제거한다
- 기존 config.json이 단일 서버 형식이면 앱 시작 시 자동 마이그레이션한다
- DB의 error_history에 기존 데이터가 있을 경우 server_id를 'legacy'로 채워 유지한다
- 서버가 1개일 때는 탭 바를 숨기고 기존 UI와 동일하게 표시한다 (서버 2개 이상일 때만 탭 표시)
- 최상위 `project_path`는 완전히 제거한다. 각 서버의 `local_path`가 그 역할을 대체한다
- pty.js에서 `activeClaudeServerId`를 추적해 서버 전환 시에만 claude를 재시작한다 (불필요한 재시작 방지)
- [+] 버튼은 새 팝업 대신 탭 바 아래 인라인 아코디언 폼으로 처리한다
- 설정 팝업의 서버 수정도 동일하게 아코디언 패턴을 사용한다 (팝업 위에 팝업 금지)
