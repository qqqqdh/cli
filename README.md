# ollacode

Ollama 로컬 LLM으로 동작하는 Claude Code / Codex / Antigravity 스타일의 에이전트 CLI입니다.

- **편의 기능**: `/` 명령 메뉴, `@` 파일 첨부, `!` 셸, `#` 메모, 권한 모드, diff 미리보기, 되돌리기, 대화 이어하기
- **이미지 읽기**: 스크린샷·사진·다이어그램·OCR (로컬 비전 모델 자동 선택)
- **MCP 다중 연결**: 기본으로 [REA](https://github.com/morluto/rea) 연결. 프리셋, Claude Code/Codex/agy 설정 가져오기, HTTP/SSE
- **스킬**: `SKILL.md` 형식(Claude Code·Codex·agy 공통). 번들 스킬 + 내 스킬 + 다른 에이전트 스킬 폴더 공유
- **🐴 Ponytail**: "게으른 시니어 개발자" 모드 ([DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT)

## 설치 및 실행

```powershell
cd C:\Users\user\Desktop\cli
npm install
npm link                          # 'ollacode' 명령 전역 등록

ollacode                          # 대화형 모드
ollacode "이 프로젝트 설명해줘"     # 첫 메시지와 함께 시작
ollacode -c                       # 마지막 대화 이어하기
ollacode --resume                 # 이어할 대화 선택
ollacode -m qwen3:14b             # 모델 지정
ollacode -i error.png "이 오류 고쳐줘"   # 이미지 첨부
ollacode -p "질문"                # 한 번만 실행 (스크립트/파이프용)
```

요구사항: Node.js 22 이상, Ollama 실행 중. REA는 Node `^22.23.4 || ^24.22.1 || >=26.12.1` 권장.

## 입력 & 단축키

| 입력 | 기능 |
| --- | --- |
| `/` | 명령어·스킬 메뉴가 바로 뜸 (입력할수록 필터링, ↑↓ 선택, Tab 완성, Enter 실행) |
| `@경로` | 파일·폴더·이미지 자동완성 후 내용 첨부 |
| `!명령` | 셸 명령을 바로 실행하고 결과를 다음 메시지 맥락에 추가 |
| `#메모` | AGENTS.md(프로젝트) 또는 ~/.ollacode/AGENTS.md(사용자)에 메모 저장 → 매 대화에 반영 |
| `?` | 단축키 패널 |

| 키 | 기능 |
| --- | --- |
| Enter / Alt+Enter·Ctrl+J·줄 끝 `\` | 전송 / 줄바꿈 |
| ↑↓ / Ctrl+R | 입력 기록 / 기록 검색 |
| Shift+Tab | 권한 모드 전환: 매번 확인 → 편집 자동 승인 → 모두 자동(yolo) |
| Esc | 응답 중단, 메뉴 닫기 (Esc 두 번: 입력 지우기) |
| Ctrl+L / Ctrl+C / Ctrl+D | 화면 지우기 / 입력 지우기·두 번이면 종료 / 종료 |
| Ctrl+A·E / Ctrl+U·K / Ctrl+W / Ctrl+←→ | 줄 처음·끝 / 앞·뒤 삭제 / 단어 삭제 / 단어 이동 |

응답 중에 미리 입력한 글자는 다음 프롬프트에 그대로 남습니다. 20초 이상 걸린 작업이 끝나면 알림음이 울립니다.

## 슬래시 명령어

| 명령 | 설명 |
| --- | --- |
| `/help`, `/keys` | 도움말, 단축키 |
| `/clear` | 새 대화 |
| `/compact [초점]` | 대화를 요약해서 컨텍스트 확보 |
| `/resume` | 이전 대화 선택해서 이어하기 (자동 저장됨) |
| `/export [파일]` | 대화를 마크다운으로 저장 |
| `/copy` | 마지막 응답을 클립보드로 복사 |
| `/undo` | 마지막 턴의 파일 변경 되돌리기 |
| `/status` | 모델, 컨텍스트 사용량, 토큰, MCP, 세션 정보 |
| `/image [경로]` | 이미지 첨부 (경로 없으면 클립보드 이미지 — Win+Shift+S 캡처 후 사용) |
| `/model [이름]`, `/models` | 모델 선택 창 / 목록 |
| `/permissions`, `/yolo` | 권한 모드 설정 |
| `/fast [on\|off\|default on\|off]` | ⚡ 빠른 모드 (저사양 PC용) |
| `/mcp …` | MCP 서버 관리 |
| `/skills [검색어\|reload]` | 스킬 목록 |
| `/ponytail [레벨]` | Ponytail 모드 |
| `/memory` | 메모리 파일 열기 |
| `/tools`, `/pin`, `/unpin`, `/think`, `/config`, `/exit` | 기타 |

## 권한과 파일 편집

읽기 전용 도구는 자동 실행됩니다. 그 외에는 화살표 선택 창이 뜹니다:
`1. 예` · `2. 이번 세션 동안 허용` · `3. 아니요, 다르게 하라고 알려주기`.
파일 편집은 **실행 전에 색깔 diff**를 보여주고, 실행 후에는 `/undo` 로 되돌릴 수 있습니다.

## 🖼 이미지 읽기

- `@screenshot.png` 또는 `/image`(클립보드)로 첨부하거나, 모델이 `view_image` 도구로 직접 봅니다.
- 현재 모델이 비전 지원이면 이미지를 그대로 전달하고, 아니면 **설치된 비전 모델이 대신 읽어서** 설명을 전달합니다.
- 비전 모델이 없으면 하나 설치하세요: `ollama pull qwen2.5vl:7b` (메모리가 적으면 `gemma3:4b`). 설정 `"visionModel"` 로 고정 가능.
- `/image-reader` 스킬: OCR, 오류 스크린샷, UI 재현, 다이어그램 읽기 지침.

## MCP 서버 관리

```powershell
ollacode mcp                                   # 상태 목록
ollacode mcp presets                           # 프리셋 목록
ollacode mcp add playwright                    # 프리셋 추가
ollacode mcp add fs -- npx -y @modelcontextprotocol/server-filesystem C:/work
ollacode mcp add api --url https://example.com/mcp -H "Authorization: Bearer TOKEN"
ollacode mcp add mytool -s project -e API_KEY=xxx -- node server.js   # 이 프로젝트에만
ollacode mcp import codex                      # claude | codex | agy | all
ollacode mcp disable rea / enable rea / remove fs / get rea
```

대화 중에는 `/mcp …` (즉시 연결/해제, `/mcp reconnect <이름>`). 프리셋: `rea`, `filesystem`, `memory`,
`sequential-thinking`, `playwright`, `chrome-devtools`, `context7`, `everything`.
도구가 많은 서버(REA 200개 이상)는 `mcp_search_tools → mcp_get_tool_schema → mcp_call_tool` 라우터로 접근해 컨텍스트를 아낍니다.

## 스킬

`/` 메뉴 또는 `/skills` 로 확인, `/<스킬이름> [인자]` 로 실행. 모델도 `search_skills`/`load_skill` 로 스스로 씁니다.

| 번들 스킬 | 용도 |
| --- | --- |
| `/reverse-engineer` | REA로 바이너리·앱 분석 |
| `/image-reader` | 이미지·스크린샷 읽기, OCR |
| `/commit`, `/code-review`, `/debug`, `/explain-code`, `/write-tests`, `/refactor` | 개발 작업 |
| `/init`, `/doc-writer` | AGENTS.md, 문서 작성 |
| `/mcp-setup`, `/skill-creator` | MCP 설정 도우미, 새 스킬 만들기 |
| `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` | Ponytail |

스킬 위치: `<프로젝트>/.ollacode/skills`, `~/.ollacode/skills`, 번들 `skills/`, 그리고
`~/.claude/skills`, `~/.codex/skills`, `~/.gemini/skills` (공유 스킬은 두 글자 이상 입력하면 `/` 메뉴에 표시).

## 🐴 Ponytail 모드

`/ponytail` (토글) · `/ponytail lite|full|ultra|off` · `/ponytail default full` (기본값 저장).
켜져 있으면 하단 상태줄에 `🐴 full` 이 표시됩니다.

## 설정

`%USERPROFILE%\.ollacode\config.json` (프로젝트별: `<프로젝트>\.ollacode\config.json` 이 덮어씀)

```json
{
  "model": "llama3.1:8b",
  "visionModel": null,
  "ollamaHost": "http://127.0.0.1:11434",
  "numCtx": 16384,
  "temperature": 0.2,
  "permissionMode": "ask",
  "ponytail": "off",
  "fast": false,
  "fastNumCtx": 8192,
  "fastToolResultChars": 3000,
  "warmup": true,
  "mcpIdleMinutes": 10,
  "skillsInPrompt": "names",
  "notify": true,
  "showThinking": true,
  "directToolLimit": 20,
  "maxDirectTools": 30,
  "maxToolResultChars": 12000,
  "externalSkillDirs": ["~/.claude/skills", "~/.codex/skills", "~/.gemini/skills", "~/.agents/skills"],
  "mcpServers": { "rea": { "command": "npx", "args": ["-y", "rea-agents", "mcp"] } }
}
```

`permissionMode`: `ask` | `acceptEdits` | `auto`. 데이터 위치: `~/.ollacode/` (sessions, history.jsonl, images, AGENTS.md).

## ⚡ 저사양 PC에서 빠르게

CPU만 있는 PC에서는 **프롬프트(시스템 프롬프트 + 도구 설명) 처리**가 가장 큰 병목입니다.
ollacode는 이를 줄이기 위해 다음을 자동으로 합니다.

- **미리 데우기**: 시작하자마자(그리고 `/clear`, `/model`, `/compact`, `/resume`, `/fast` 후) 프롬프트를 백그라운드에서
  미리 처리해 둡니다. 하단에 `⏳ 준비 중` → `✓ 준비됨` 으로 표시되고, 그 사이 질문을 입력하면 됩니다.
- **프롬프트 고정**: 세션 동안 시스템 프롬프트와 도구 목록을 고정해서 Ollama의 프롬프트 캐시가 깨지지 않게 합니다.
  MCP가 나중에 연결돼도 프롬프트는 그대로이고, 대화 중 Ponytail·메모(`#`)·스킬 변경은 다음 메시지에 알림으로 붙습니다.

- **필요할 때만 불러오기 (지연 로딩)**:
  - MCP 서버는 시작할 때 띄우지 않고, 도구가 처음 호출될 때 연결합니다. 한 번 연결하면 도구 목록을
    `~/.ollacode/mcp-cache/` 에 저장해서 다음부터는 서버를 띄우지 않고도 검색할 수 있습니다.
  - 메시지에 서버 관련 단어(예: REA → `.exe`, `apk`, `리버스`, `디컴파일`)가 있으면 백그라운드로 미리 연결하고,
    모델에게 해당 서버를 쓰라는 힌트를 그 메시지에만 붙입니다.
  - 10분(`mcpIdleMinutes`) 동안 안 쓴 서버는 종료해서 메모리를 돌려받습니다. 필요하면 다시 자동 연결됩니다.
  - 꼭 필요한 서버만 `/mcp essential <이름>` 으로 시작할 때부터 연결합니다. 수동 제어: `/mcp connect|stop <이름>`.
  - 스킬은 프롬프트에 **이름만** 넣고(`skillsInPrompt: "names"`), 메시지에 "커밋해줘", "리뷰해줘" 같은 트리거 문구가 있으면
    해당 스킬을 쓰라는 힌트를 붙입니다. 내용은 `load_skill` 로 그때 불러옵니다.

**빠른 모드** (`/fast`, `ollacode --fast`, 기본값으로: `/fast default on`)

| | 일반 | 빠른 모드 |
| --- | --- | --- |
| 시스템 프롬프트 | 스킬 목록·상세 규칙 포함 | 핵심만 (스킬은 `load_skill` 로 찾아 씀) |
| 도구 | 전체 + MCP 직접 노출 | read/write/edit/list/grep/shell/load_skill + MCP 라우터, 설명 축약 |
| 컨텍스트 (`num_ctx`) | 16384 | 8192 (`fastNumCtx`) |
| 도구 결과 최대 | 12000자 | 3000자 (`fastToolResultChars`) |
| `read_file` 기본 | 2000줄 | 250줄 |
| thinking | 설정대로 | 지원 모델이면 끔 |

`/status` 에서 미리 처리 상태와 마지막 요청의 프롬프트 처리 시간을 볼 수 있고, 응답 끝에도
`프롬프트 1,746 tok 1.1s` 처럼 표시됩니다.

Ollama 쪽 권장 설정 (사용자 환경변수 → Ollama 재시작):

```powershell
setx OLLAMA_FLASH_ATTENTION 1
setx OLLAMA_KV_CACHE_TYPE q8_0
```

그리고 가장 효과가 큰 것은 **작은 모델**입니다: `ollama pull qwen3:4b` (균형) / `qwen3:1.7b` (아주 빠름).

## 모델 선택 팁

도구 호출 지원 모델이 필요합니다(`/model` 에 `tools` 표시). 8B 모델은 엉뚱한 도구를 부르거나 스킬 지침을 끝까지
따르지 못하는 경우가 많습니다. `qwen3:14b`, `qwen3-coder:30b`, `gpt-oss:20b` 이상을 권장합니다.

## 구조

```
bin/ollacode.js     진입점
src/index.js        인자/하위명령, 시작 화면
src/repl.js         대화 루프, 슬래시 명령, 자동완성, 권한 창
src/editor.js       라인 에디터 (실시간 메뉴, 한글 폭, 붙여넣기, 선택 창)
src/agent.js        에이전트 루프, 시스템 프롬프트, 권한, 되돌리기, 요약
src/markdown.js     스트리밍 마크다운 렌더링
src/diff.js         편집 diff
src/sessions.js     대화 저장/이어하기/내보내기
src/files.js        @ 파일 인덱스와 첨부
src/images.js       비전 모델 선택, 이미지 설명, 클립보드 이미지
src/ollama.js       Ollama 클라이언트
src/mcp.js, mcpConfig.js, mcpCommands.js   MCP 연결/설정/명령
src/skills.js       스킬 탐색/로드
src/tools.js        내장 도구
skills/             번들 스킬 (ponytail* 은 MIT, skills/ponytail/LICENSE)
```
