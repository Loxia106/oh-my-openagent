# oh-my-openagent for OpenCode 2

[Oh My OpenAgent](https://github.com/code-yeongyu/oh-my-openagent)(OMO)의 에이전트 파이프라인을 **OpenCode 2.0.18 네이티브 플러그인 API**로 옮긴 개인 포크입니다. Sisyphus·Hephaestus·Prometheus·Atlas와 보조 에이전트의 프롬프트, 전용 스킬, 명령어, 훅, 위임, 검토, 작업 재개를 OpenCode 2에서 그대로 쓰는 것이 목표입니다.

> [!IMPORTANT]
> - 공식 Oh My OpenAgent 배포판이 아닙니다. 업스트림의 `bunx oh-my-openagent install`이나 npm 패키지로는 이 포크가 설치되지 않습니다.
> - 대상은 **OpenCode 2.0.18**입니다. OpenCode 1.x에서는 동작하지 않습니다.
> - 원본의 라이선스와 고지([LICENSE.md](LICENSE.md))가 그대로 적용됩니다.

## 목차

- [포함된 기능](#포함된-기능)
- [요구 사항](#요구-사항)
- [설치: macOS / Linux](#설치-macos--linux)
- [설치: Windows (WSL2)](#설치-windows-wsl2)
- [설치 확인](#설치-확인)
- [선택 기능 켜기](#선택-기능-켜기)
- [사용 흐름](#사용-흐름)
- [업데이트](#업데이트)
- [제거](#제거)
- [문제 해결](#문제-해결)
- [검증 범위와 한계](#검증-범위와-한계)
- [출처와 라이선스](#출처와-라이선스)

## 포함된 기능

| 영역 | 내용 |
| --- | --- |
| 에이전트 | Sisyphus, Hephaestus, Prometheus, Atlas, Sisyphus-Junior, Explore, Librarian, Oracle, Metis, Momus, Multimodal-Looker |
| 위임 | `task`(카테고리/서브에이전트), `call_omo_agent`, `look_at`, 백그라운드 실행과 `bg_` 작업 ID, `background_output`/`background_cancel`, 불안정 모델 감시 실행 |
| 워크플로 | ultrawork, `/ulw-execute`(Prometheus → Atlas), 최종 검토(final wave), `/goal`, 할 일 이어하기, `/stop-continuation` |
| Team | `team_*` 도구, `/hyperplan`, 메일박스·공유 작업, 멤버별 **네이티브 worktree 격리**, 서버 재시작 후 복구 |
| 긴 대화 | 선제 압축, 압축 문맥 보존(목표·계획·위임 세션), 압축 전용 모델, 도구 출력 동적 절단 |
| 모델 정책 | 런타임 폴백, 요구 모델 체인 폴백, 무응답 자식 워치독, ultrawork 전용 모델 |
| 명령·스킬 | OMO 내장 명령, Claude 명령/스킬 가져오기(`!`셸·`@`파일·`$ARGUMENTS[N]`·subtask), 스킬 MCP |
| 기타 | 규칙·README 주입, 주석 검사, 해시라인 편집, 모니터 도구, 세션 검색, Claude Code 훅 |

기능별 상세 동작과 기존 플러그인과의 차이는 [호환성 문서](docs/opencode2-compatibility.md)에 있습니다.

## 요구 사항

| 항목 | 버전 / 설명 |
| --- | --- |
| OpenCode | **2.0.18** (`@opencode/cli`) |
| Git | 저장소 복제와 Team worktree에 필요 |
| Bun | 1.4.2로 빌드·검증했습니다 |
| Node.js + npm | 20 이상. OpenCode CLI 설치와 첫 빌드(내장 LSP 도구 의존성 설치)에 사용 |
| 모델 공급자 | OpenCode에 로그인한 공급자 계정 또는 API 키 |

## 설치: macOS / Linux

**1. OpenCode 2.0.18 설치**

```bash
npm install -g @opencode/cli@2.0.18
```

```bash
opencode --version
```

`opencode v2.0.18`이 출력되면 됩니다.

**2. 이 저장소 복제**

```bash
git clone https://github.com/Loxia106/oh-my-openagent.git ~/oh-my-openagent
```

```bash
cd ~/oh-my-openagent && bun install --ignore-scripts --frozen-lockfile
```

기본 브랜치가 `codex/opencode2-compat`이므로 별도 브랜치 지정은 필요 없습니다.

**3. 빌드하고 OpenCode에 등록**

모든 프로젝트에서 쓰려면 전역 설정 디렉터리에 등록합니다. `XDG_CONFIG_HOME`을 바꾸지 않았다면 `~/.config/opencode`입니다.

```bash
bun run install:opencode2 -- --config-dir ~/.config/opencode
```

특정 프로젝트에서만 쓰려면 대신 이렇게 합니다.

```bash
bun run install:opencode2 -- --project /절대/경로/작업프로젝트
```

- 설치 명령은 `dist/opencode2/`를 빌드합니다.
- 대상 폴더의 `opencode.jsonc`(또는 기존 `opencode.json`)의 `plugins`에 그 절대 경로를 추가합니다.
- `default_agent`가 없을 때만 `sisyphus`로 설정합니다.
- 기존 설정 파일은 수정하기 전에 백업합니다.

**4. OpenCode 백그라운드 서버 재시작**

```bash
opencode service restart
```

**5. 모델 공급자 로그인**

`opencode auth`로 공급자에 로그인합니다. 하위 명령은 `opencode auth --help`에서 확인할 수 있습니다. 이 포크의 설치 명령은 공급자나 API 키를 설정하지 않습니다.

> [!WARNING]
> 설치 경로는 **복제한 저장소의 절대 경로**로 등록되며, 플러그인은 저장소의 `node_modules`를 사용합니다. 저장소를 지우거나 옮기지 마세요. 옮겼다면 새 위치에서 3~4단계를 다시 실행하면 됩니다.

## 설치: Windows (WSL2)

OpenCode와 이 플러그인은 **WSL2의 Linux 안에서** 설치하고 실행합니다. Windows용 OpenCode는 WSL 안의 플러그인 경로를 불러올 수 없습니다.

**1. WSL2와 Ubuntu 설치** — PowerShell을 관리자 권한으로 열고 실행한 뒤 재부팅합니다.

```powershell
wsl --install -d Ubuntu
```

이후 작업은 모두 **Ubuntu 터미널**에서 합니다.

**2. 기본 도구 설치**

```bash
sudo apt update && sudo apt install -y git curl unzip ca-certificates
```

**3. Node.js 22 설치** (Ubuntu 기본 저장소의 Node.js는 버전이 낮을 수 있습니다)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs
```

`sudo` 없이 전역 npm 패키지를 설치하도록 경로를 지정합니다.

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
```

**4. Bun 1.4.2 설치**

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
```

```bash
source ~/.bashrc
```

**5. OpenCode 설치와 플러그인 등록** — 나머지는 [macOS / Linux 설치](#설치-macos--linux)의 1~5단계와 같습니다.

```bash
npm install -g @opencode/cli@2.0.18
```

```bash
git clone https://github.com/Loxia106/oh-my-openagent.git ~/oh-my-openagent
```

```bash
cd ~/oh-my-openagent && bun install --ignore-scripts --frozen-lockfile
```

```bash
bun run install:opencode2 -- --config-dir ~/.config/opencode
```

```bash
opencode service restart
```

WSL에서 지킬 점:

- **저장소와 작업 프로젝트를 모두 Linux 파일시스템(`~/...`)에 두세요.** `/mnt/c/...` 아래에서는 파일 감시, 권한, 심볼릭 링크, git worktree가 느리거나 불안정합니다.
- Windows 쪽 폴더에서 작업해야 한다면 저장소를 WSL 안으로 복제해 쓰는 편이 안전합니다.
- 브라우저 로그인이 필요한 공급자는 WSL이 띄우는 URL을 Windows 브라우저에서 열어 인증합니다.
- VS Code를 쓴다면 WSL 확장으로 Ubuntu에 접속한 뒤 그 터미널에서 `opencode`를 실행합니다.

## 설치 확인

작업할 프로젝트 폴더에서 OpenCode를 실행합니다.

```bash
opencode ~/작업프로젝트
```

- 기본 에이전트가 **Sisyphus**로 표시되고, 에이전트 목록에 Hephaestus·Prometheus·Atlas가 보이면 정상입니다.
- 명령 목록에 `/ulw-execute`, `/goal`, `/hyperplan` 같은 OMO 명령이 보여야 합니다.
- 보이지 않으면 [문제 해결](#문제-해결)을 참고하세요.

## 선택 기능 켜기

작업 프로젝트의 `.omo/omo.jsonc`(또는 사용자 전역 OMO 설정)의 `"[opencode]"` 블록에서 켭니다.

```jsonc
{
  "[opencode]": {
    "team_mode": { "enabled": true },
    "goal": { "enabled": true },
    "experimental": { "preemptive_compaction": true },
    "runtime_fallback": { "enabled": true }
  }
}
```

| 설정 | 효과 |
| --- | --- |
| `team_mode.enabled` | Team 도구와 `/hyperplan` |
| `goal.enabled` | `/goal`과 목표 도구. `default_mode.goal: true`면 첫 입력을 자동 목표로 설정 |
| `experimental.preemptive_compaction` | 컨텍스트 78%에서 자동 압축 |
| `experimental.aggressive_truncation` | 압축 요청 안의 큰 도구 결과를 줄임 |
| `agents.<이름>.compaction.model` | 압축 요약 전용 모델 |
| `agents.<이름>.ultrawork` | `ultrawork`/`ulw` 턴 전용 모델·변형 |
| `runtime_fallback` | 공급자 오류 시 폴백 모델로 전환(`timeout_seconds`로 무응답 폴백 차단) |
| `model_fallback` | 에이전트 기본 요구 모델 체인을 폴백으로 사용 |
| `monitor.enabled` | `monitor_*` 도구 |
| `hashline_edit` | `read`/`edit`를 `LINE#ID` 앵커 방식으로 전환 |

전체 옵션과 동작은 [한국어 설치·실행 안내](docs/opencode2-quickstart.ko.md)와 [호환성 문서](docs/opencode2-compatibility.md)에 있습니다.

## 사용 흐름

- **일반 작업:** Sisyphus(또는 Hephaestus)에게 요청합니다. Explore·Librarian 조사, Junior 구현, Oracle 검토 결과를 부모 대화가 이어받습니다. 프롬프트에 `ultrawork`(`ulw`)를 넣으면 최대 강도로 진행합니다.
- **계획 후 실행:** Prometheus에서 계획을 세우고, `/ulw-execute`로 Atlas 실행 흐름에 넘깁니다. 최종 검토(final wave)를 통과해도 **사용자의 완료 승인**이 있어야 끝납니다.
- **Team:** `team_mode`를 켠 뒤 `/hyperplan`을 쓰거나 리더에게 팀 구성을 요청합니다.
  - 멤버 스펙에 `worktree: true`를 주면 그 멤버는 OpenCode 네이티브 worktree(`<프로젝트>/.omo/worktrees`)에서 격리되어 작업합니다.
  - 멤버의 변경은 리더가 통합합니다.
  - `team_delete`는 변경이 남은 worktree를 지우지 않고 경로만 알려 줍니다.
- **자동 이어하기 중지:** `/stop-continuation`

## 업데이트

```bash
cd ~/oh-my-openagent && git pull --ff-only && bun install --ignore-scripts --frozen-lockfile
```

```bash
bun run install:opencode2 -- --config-dir ~/.config/opencode
```

```bash
opencode service restart
```

설치할 때 `--project`를 썼다면 같은 옵션으로 다시 실행합니다.

## 제거

1. 설치 대상 `opencode.jsonc`의 `plugins`에서 `.../oh-my-openagent/dist/opencode2` 항목을 지웁니다. 설치 명령이 추가했다면 `default_agent`도 지웁니다.
2. `opencode service restart`를 실행합니다.
3. 복제한 저장소를 삭제합니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| OMO 에이전트·명령이 보이지 않음 | `opencode service restart`를 했는지, `opencode.jsonc`의 `plugins` 경로가 실제 `dist/opencode2`를 가리키는지 확인 |
| 저장소를 옮긴 뒤 동작하지 않음 | 새 위치에서 설치 명령을 다시 실행하고 서비스를 재시작 |
| `task`·`look_at` 도구가 사라짐 | OpenCode 2의 복수형 `permissions` 배열을 쓰세요. 구형 단수형 `permission`의 `task`는 `subagent`로 바뀌어 OMO 도구가 숨겨질 수 있습니다 |
| MCP 도구가 보이지 않음 | MCP는 CodeMode로 노출됩니다. `execute`와 해당 MCP 동작 권한이 모두 필요합니다 |
| Team worktree 멤버가 바로 오류 | worktree 위치에서 OMO가 로드되지 않은 경우입니다. 기본 위치(`.omo/worktrees`)를 쓰거나 플러그인을 전역 설정에 등록하세요 |
| WSL에서 느리거나 파일 변경을 못 잡음 | 저장소와 프로젝트를 `/mnt/c`가 아닌 `~/` 아래로 옮기세요 |

## 검증 범위와 한계

- 기능마다 격리된 실제 OpenCode 2.0.18 호스트에서 QA 드라이버(`script/opencode2-*-qa.ts`)로 검증했습니다. 결과는 [에이전트 파이프라인 검증](docs/opencode2-agent-pipelines.md)에 있습니다.
- QA는 로컬 모의 모델을 사용합니다. 연동과 전달이 되는지는 확인했지만, 실제 모델의 추론 품질이나 모든 외부 공급자와의 호환성까지 입증하지는 않습니다.
- 알림·업데이트 안내·텔레메트리처럼 대화에 영향이 없는 기능은 의도적으로 뺐습니다. 남은 차이는 [호환성 문서](docs/opencode2-compatibility.md)에 정리했습니다.

## 출처와 라이선스

- 원본: [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) 5.0.0 기반, 5.0.1의 OpenCode 대화 라우팅 변경 반영
- 라이선스: 원본 저장소의 [LICENSE.md](LICENSE.md)가 그대로 적용됩니다.
- 이 포크의 변경 내역은 git 기록과 `docs/opencode2-*.md`에 있습니다.
