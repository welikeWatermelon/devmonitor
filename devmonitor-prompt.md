# DevMonitor — Claude Code 개발 프롬프트

## 프로젝트 개요

**DevMonitor**는 AWS EC2 서버를 모니터링하고, 에러 로그를 감지해 Claude Code AI에게 자동으로 전달하는 운영 도구다.
에러 수정 권한은 사람(운영자)이 갖는다. AI는 분석만 한다.

---

## 기술 스택

- **언어:** Node.js 16+
- **섹터 1 (로컬 터미널):** `node-pty` (microsoft/node-pty) — Windows ConPTY 지원
- **섹터 2, 3 (SSH 연결):** `ssh2` (mscdex/ssh2) — pure JavaScript, PEM 키 지원
- **에러 이력 저장:** SQLite (`better-sqlite3`)
- **UI 프레임워크:** Electron (3섹터 분할 레이아웃, HTML/CSS/JS)
- **설정 저장:** `config.json` (앱 루트에 위치)

---

## 레이아웃 구조

```
┌─────────────────────────────────────────────────────────────────┐
│  DevMonitor  ● 연결됨    [모드 A|B]  [붙여넣기/분석하기] [알림🔔] [설정⚙]  │
├──────────────────────────────┬──────────────────────────────────┤
│                              │                                  │
│   섹터 1 - Claude Code       │   섹터 2 - 서버 로그             │
│   (node-pty, 로컬 터미널)    │   (SSH, tail -F, grep ERROR)     │
│   전체 높이의 60%            │   우측 상단 50%                  │
│                              │                                  │
├──────────────────────────────├──────────────────────────────────┤
│                              │                                  │
│   에러 분석 로그             │   섹터 3 - 서버 현황             │
│   (에러 그룹 + 타임스탬프)   │   (SSH, btop)                   │
│   [해결하기] 버튼            │   우측 하단 50%                  │
│   전체 높이의 40%            │                                  │
└──────────────────────────────┴──────────────────────────────────┘
```

- 좌측 컬럼 (flex: 1.3): 섹터 1 상단 + 에러 분석 로그 하단
- 우측 컬럼 (flex: 1): 섹터 2 상단 + 섹터 3 하단
- 섹터 간 구분선: 0.5px border

---

## 상단 바 구성

왼쪽부터 순서대로:
1. 앱 이름 `DevMonitor` + 연결 상태 표시 (● 연결됨 / ● 끊김)
2. 모드 토글: `A` | `B` (pill 형태, 선택된 쪽 강조)
3. 액션 버튼:
   - 모드 A 선택 시: `[붙여넣기]` 버튼만 표시
   - 모드 B 선택 시: `[분석하기]` 버튼만 표시
4. 알림 ON/OFF 토글 버튼 (🔔 / 🔕)
5. 설정 버튼 `[설정⚙]` — 클릭 시 작은 팝업 열림

---

## 모드 동작

### 모드 A — 수동 붙여넣기
```
에러 감지
    ↓
에러 텍스트 클립보드 자동 복사
    ↓
알림 표시 (알림 ON 상태일 때)
    ↓
운영자가 섹터 1에서 Ctrl+V 후 Claude Code에 질문
```

### 모드 B — 자동 분석
```
에러 감지
    ↓
node-pty를 통해 섹터 1 터미널에 에러 텍스트 자동 주입
    ↓
엔터 자동 입력
    ↓
Claude Code가 프로젝트를 읽고 분석
    ↓
분석 결과를 에러 분석 로그 패널에 저장 및 표시
```

**모드 B 중요 주의사항:**
- 셸이 준비된 후(프롬프트 감지 후)에 텍스트를 주입해야 한다
- Claude Code가 응답 중일 때 새 에러가 들어오면 큐에 쌓고 순서대로 처리한다
- AI는 분석만 한다. 코드 자동 수정/배포는 절대 하지 않는다

---

## 에러 분석 로그 패널

에러 분석 로그는 좌측 하단에 위치하며 다음 정보를 표시한다:

- **에러 그룹:** 에러 타입 + 파일:라인 기준으로 동일 에러를 묶는다
  - 예: `NullPointerException @ UserService.java:142`
- **타임스탬프 목록:** 해당 에러가 발생한 시각들을 나열
  - 예: `14:23:45` `14:24:31` `15:01:02`
- **분석 요약:** Claude Code 분석 결과 한 줄 요약
- **[해결하기] 버튼:** 클릭 시 해당 파일을 VSCode에서 열기
  - 실행 명령: `code {파일경로}:{라인번호}`

---

## 설정 팝업

설정 버튼 클릭 시 우측 상단에 작은 팝업으로 표시된다.
설정값은 `config.json`에 저장된다.

```json
{
  "pem_key_path": "C:/Users/.../keys/server.pem",
  "ec2_ip": "13.125.xxx.xxx",
  "username": "ec2-user",
  "port": 22,
  "log_path": "/home/ec2-user/app/logs/spring.log",
  "project_path": "C:/Users/.../my-spring-app"
}
```

설정 저장 전 유효성 검사:
- PEM 파일 존재 여부 확인
- EC2 IP 형식 확인
- 로컬 프로젝트 경로 존재 여부 확인

---

## SSH 연결 (섹터 2, 3)

### 섹터 2 — 서버 로그
```javascript
conn.exec('tail -F ' + config.log_path + ' | grep --line-buffered -E "ERROR|WARN"', (err, stream) => {
  stream.on('data', (data) => {
    const line = data.toString('utf8');
    displayInSector2(line);
    detectError(line);
  });
});
```

### 섹터 3 — btop
```javascript
conn.shell({ term: 'xterm-256color' }, (err, stream) => {
  stream.write('btop\n');
  stream.on('data', (data) => {
    displayInSector3(data.toString('utf8'));
  });
});
```

### 자동 재연결 (Exponential Backoff)
```
연결 끊김 감지
    ↓
1초 후 재시도 → 실패 시 2초 → 4초 → 8초 → ... 최대 30초
재연결 성공 시 backoff 초기화
```

SSH keep-alive 설정 필수:
```javascript
{
  keepaliveInterval: 10000,  // 10초마다 keep-alive 전송
  keepaliveCountMax: 3       // 3번 무응답 시 끊김으로 판단
}
```

---

## 에러 감지 로직

### 에러 그룹핑 기준
- `에러 타입 + 파일명:라인번호` 조합을 키(key)로 사용
- 같은 키 = 같은 에러 그룹

### 디바운싱
- 동일 에러 그룹은 30초 내에 1번만 처리
- 30초 내 재발 시: 카운트 증가 + 타임스탬프 추가만 함, 알림 없음

### 에러 플러드 방어
- 초당 에러 감지 횟수에 rate limit 적용 (초당 최대 10건 처리)
- 나머지는 드롭하고 "에러 폭증 감지됨" 경고 표시

---

## 에러 이력 (SQLite)

```sql
CREATE TABLE error_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_key TEXT NOT NULL,        -- 에러 타입 + 파일:라인
  error_type TEXT NOT NULL,       -- NullPointerException 등
  file_location TEXT,             -- UserService.java:142
  first_seen DATETIME,
  last_seen DATETIME,
  count INTEGER DEFAULT 1,
  analysis TEXT,                  -- Claude Code 분석 결과
  resolved INTEGER DEFAULT 0      -- 0: 미해결, 1: 해결됨
);
```

---

## 프로그램 시작 시 자동 흐름

1. `config.json` 읽기 (없으면 설정 팝업 자동 오픈)
2. 설정 유효성 검사
3. 섹터 1: node-pty로 CMD 생성 → `cd {project_path}` → `claude` 실행
   - 셸 프롬프트(`>`, `$`) 감지 후 명령 실행
4. 섹터 2: ssh2로 EC2 접속 → `tail -F {log_path} | grep ERROR` 실행
5. 섹터 3: ssh2로 EC2 접속 → `btop` 실행
6. 상단 바 연결 상태 업데이트

---

## 알림

- 알림 ON 상태에서 새 에러 그룹 첫 감지 시: 시스템 Notification API 사용
- 알림 OFF 상태: 에러 감지는 계속되지만 시스템 알림 없음
- 같은 에러 재발 시: 알림 없이 카운트만 업데이트

---

## 예상 에러 및 방어 로직

| 상황 | 방어 방법 |
|------|----------|
| node-pty 빌드 실패 | 실행 전 node-pty import 체크, 실패 시 설치 안내 메시지 |
| Windows 1809 미만 | 시작 시 OS 버전 체크, 미만이면 경고 후 종료 |
| SSH 연결 실패 | Exponential backoff 재연결 + 섹터에 "재연결 중..." 표시 |
| SSH 세션 무음 종료 | keepaliveInterval로 감지 |
| PEM 파일 없음 | 설정 저장 전 파일 존재 확인 |
| Claude Code 미설치 | 시작 시 `claude --version` 실행해 확인, 실패 시 안내 |
| btop 미설치 | 섹터 3에 "btop을 EC2에 설치해주세요" 안내 |
| 로그 파일 경로 틀림 | tail 실행 실패 감지 후 설정 팝업 안내 |
| 한국어 로그 깨짐 | SSH 스트림 및 node-pty 인코딩 UTF-8 명시 |
| 에러 플러드 | Rate limiting + 디바운싱 |
| write 타이밍 오류 | 프롬프트 문자열 감지 후 명령 실행 |

---

## 파일 구조 (권장)

```
devmonitor/
├── main.js              # Electron 메인 프로세스
├── preload.js           # Electron preload
├── renderer.js          # UI 렌더러
├── index.html           # 메인 레이아웃
├── style.css            # 스타일
├── config.json          # 사용자 설정 (gitignore)
├── db.js                # SQLite 연결 및 쿼리
├── ssh.js               # SSH 연결 관리 (섹터 2, 3)
├── pty.js               # node-pty 관리 (섹터 1)
├── errorDetector.js     # 에러 감지 + 디바운싱 + 그룹핑
├── errorHistory.db      # SQLite DB 파일 (gitignore)
├── package.json
└── devmonitor-prompt.md # 이 파일
```

---

## 개발 순서 (권장)

1. Electron 기본 레이아웃 구성 (3섹터 분할)
2. 설정 팝업 + config.json 저장/로드
3. ssh2로 섹터 2 SSH 연결 + 로그 스트림 표시
4. ssh2로 섹터 3 SSH 연결 + btop 표시
5. 에러 감지 로직 + 디바운싱 + 그룹핑
6. 에러 분석 로그 패널 UI
7. node-pty로 섹터 1 터미널 + claude 자동 실행
8. 모드 A (클립보드 복사) 구현
9. 모드 B (자동 주입) 구현
10. SQLite 에러 이력 저장
11. [해결하기] 버튼 (VSCode 연동)
12. 자동 재연결 로직
13. 알림 ON/OFF
14. 예외 처리 및 에러 방어 로직 전체 점검

---

## 주의사항 (반드시 지킬 것)

- AI(Claude Code)는 에러 분석만 한다. 코드 자동 수정/배포 기능은 만들지 않는다
- PEM 키는 경로만 저장한다. 키 내용 자체를 DB나 파일에 저장하지 않는다
- 모든 SSH 스트림과 PTY 인코딩은 UTF-8로 명시한다
- node-pty write는 반드시 셸 프롬프트 감지 이후에 실행한다
- 에러 분석 로그는 SQLite에 영구 저장해 세션 종료 후에도 이력이 유지되도록 한다
