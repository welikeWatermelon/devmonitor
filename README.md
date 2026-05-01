# DevMonitor

AWS EC2 서버의 에러 로그를 실시간으로 감지하고, Claude Code AI에게 자동으로 전달하는 운영 모니터링 도구.

에러 수정 권한은 운영자에게 있다. AI는 분석만 한다.

![Electron](https://img.shields.io/badge/Electron-2C2E3B?style=flat&logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-16+-339933?style=flat&logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%2010%201809+-0078D6?style=flat&logo=windows&logoColor=white)

---

## 화면 구성

```
┌──────────────────────┬──────────────────────┐
│                      │  서버 로그 (섹터 2)  │
│  Claude Code (섹터1) │  [백엔드] [프론트]   │
│                      ├──────────────────────┤
├──────────────────────┤  서버 현황 (섹터 3)  │
│  에러 분석 로그      │  btop 대시보드       │
└──────────────────────┴──────────────────────┘
```

- **섹터 1** — 로컬 터미널. Claude Code가 실행되며 에러를 분석한다.
- **섹터 2** — EC2 서버 로그 실시간 스트리밍 (SSH).
- **섹터 3** — EC2 서버 리소스 현황 (btop, SSH).
- **에러 분석 로그** — 감지된 에러 그룹과 Claude Code의 분석 결과 이력.

---

## 동작 방식

### 모드 A — 수동 붙여넣기
에러 감지 → 클립보드 자동 복사 → 알림 → 운영자가 Ctrl+V로 Claude Code에 질문

### 모드 B — 자동 분석
에러 감지 → Claude Code 터미널에 에러 텍스트 자동 주입 → 엔터 → Claude Code가 프로젝트를 읽고 분석 → 결과를 에러 분석 로그에 저장

---

## 필수 설치 항목

### 1. Node.js 16 이상
https://nodejs.org

### 2. Visual Studio Build Tools 2022
node-pty 네이티브 모듈 빌드에 필요하다.

https://aka.ms/vs/17/release/vs_BuildTools.exe

설치 시 **"C++ 빌드 도구"** 워크로드 선택.

### 3. Python 3 + setuptools
```bash
pip install setuptools
```

### 4. Claude Code CLI
```bash
npm install -g @anthropic-ai/claude-code
```

설치 후 로그인:
```bash
claude login
```

### 5. EC2 서버에 btop 설치
```bash
# Amazon Linux / CentOS
sudo yum install -y btop

# Ubuntu
sudo apt install -y btop
```

### 6. PEM 키 파일
EC2 접속에 사용하는 `.pem` 키 파일이 로컬에 있어야 한다.

---

## 설치

```bash
# 1. 클론
git clone https://github.com/{username}/devmonitor.git
cd devmonitor

# 2. 패키지 설치
npm install

# 3. 네이티브 모듈 재빌드 (node-pty, better-sqlite3)
npx electron-rebuild

# 4. 실행
npm start
```

---

## 설정

앱 실행 후 우측 상단 ⚙ 버튼을 클릭해 설정 팝업을 연다.

### 서버 추가
`+ 서버 추가` 버튼을 클릭하면 인라인 폼이 펼쳐진다.

| 항목 | 설명 | 예시 |
|------|------|------|
| 서버 ID | 고유 식별자 (영문, 하이픈 허용) | `backend` |
| 서버 이름 | 탭에 표시될 이름 | `백엔드` |
| PEM 경로 | PEM 키 파일 로컬 경로 | `C:/Users/.../server.pem` |
| EC2 IP | EC2 퍼블릭 IP | `13.125.xxx.xxx` |
| 사용자명 | SSH 접속 사용자 | `ec2-user` |
| 포트 | SSH 포트 (기본 22) | `22` |
| 로그 경로 | EC2 내 로그 파일 경로 | `/home/ec2-user/app/logs/spring.log` |
| 로컬 경로 | 해당 서버의 로컬 프로젝트 경로 | `C:/Users/.../my-project/backend` |

서버를 여러 개 추가하면 섹터 2, 3에 탭이 생긴다.

### config.json (직접 편집 시)

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
    }
  ]
}
```

---

## OS 요구사항

- **Windows 10 버전 1809 이상** (node-pty ConPTY 지원 최소 버전)
- Windows 11 권장

---

## 주의사항

- AI(Claude Code)는 에러 분석만 한다. 코드 자동 수정·배포 기능은 없다.
- PEM 키는 경로만 저장된다. 키 내용은 어디에도 저장되지 않는다.
- `config.json`과 `errorHistory.db`는 `.gitignore`에 포함되어 있다. 절대 커밋하지 않는다.

---

## 기술 스택

| 역할 | 라이브러리 |
|------|----------|
| 데스크톱 프레임워크 | Electron |
| 로컬 터미널 (섹터 1) | node-pty |
| SSH 연결 (섹터 2, 3) | ssh2 |
| 터미널 렌더링 | xterm.js |
| 에러 이력 저장 | better-sqlite3 |
| 설정 저장 | config.json |

---

## 라이선스

MIT
