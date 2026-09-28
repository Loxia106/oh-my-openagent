# OpenCode 2에서 OMO 에이전트 사용하기

이 포크는 OpenCode **2.0.18**의 네이티브 플러그인 API를 사용합니다. Sisyphus, Hephaestus, Prometheus, Atlas와 보조 에이전트의 프롬프트·스킬·명령·도구·위임·작업 재개가 작업 범위입니다. 업스트림 공식 배포판은 아닙니다. 기능별 검증 결과와 남은 차이는 [에이전트 검증 문서](opencode2-agent-pipelines.md)와 [호환성 표](opencode2-compatibility.md)에 기록합니다.

## 설치

OpenCode 2.0.18, Bun, Node.js 20 이상과 npm이 있는 환경에서 실행합니다. 첫 빌드는 포함된 LSP 도구의 의존성을 npm으로 설치합니다. 이 포크의 빌드와 검증에는 Bun 1.4.2를 사용했습니다.

```sh
git clone --branch codex/opencode2-compat https://github.com/Loxia106/oh-my-openagent.git
cd oh-my-openagent
bun install --ignore-scripts --frozen-lockfile
bun run install:opencode2 -- --project /절대/경로/작업프로젝트
```

`install:opencode2`는 빌드 후 지정한 프로젝트의 `opencode.jsonc` 또는 기존 `opencode.json`에 플러그인 경로를 등록합니다. 기존 파일을 변경할 때는 백업을 만듭니다. 전역 설정 디렉터리를 대상으로 삼으려면 `--project` 대신 `--config-dir /절대/경로/opencode설정`을 사용합니다. 두 옵션은 함께 사용하지 않습니다.

등록되는 경로는 이 저장소의 `dist/opencode2` 절대 경로입니다. 저장소와 `node_modules`를 유지하세요. 저장소를 옮겼다면 새 위치에서 설치 명령을 다시 실행합니다. 이 작업은 모델 공급자 로그인이나 API 키 설정을 대신하지 않습니다.

## 선택 기능

작업 프로젝트의 `.omo/omo.jsonc`에서 필요한 기능을 켭니다. 기존 파일이 있다면 아래 항목을 병합합니다.

```jsonc
{
  "[opencode]": {
    "team_mode": { "enabled": true },
    "goal": { "enabled": true }
  }
}
```

Team/Hyperplan에는 `[opencode].team_mode.enabled`, `/goal`과 목표 도구에는 `[opencode].goal.enabled`가 필요합니다. 첫 사용자 입력을 자동 목표로 삼으려면 `[opencode].default_mode.goal`도 `true`로 설정합니다. 이미 저장된 목표는 그대로 유지하며 자식 에이전트에는 자동 목표를 만들지 않습니다. 사용할 모델은 OpenCode에 등록하고 OMO의 에이전트·카테고리 설정으로 지정합니다. 선택적 LSP, tmux 및 외부 MCP 서버에는 각 기능의 실행 파일과 설정도 필요합니다.

긴 대화와 모델 정책 기능도 같은 파일에서 켭니다. 모두 기본값은 꺼져 있습니다.

- `experimental.preemptive_compaction`: 컨텍스트의 78%에서 자동 압축을 시작합니다.
- `experimental.aggressive_truncation`: 압축 요청 안의 큰 도구 결과를 줄입니다.
- `agents.<이름>.compaction.model`: 압축 요약에 쓸 모델을 지정합니다.
- `agents.<이름>.ultrawork`: `ultrawork`/`ulw` 턴에 쓸 모델과 변형을 지정합니다.
- `runtime_fallback`: 공급자 오류 시 폴백 체인으로 전환하며, `timeout_seconds`로 응답 없는 폴백을 끊습니다.
- `model_fallback`: 에이전트 기본 요구 모델 체인을 폴백으로 사용합니다.
- `monitor.enabled`: `monitor_*` 도구를 켭니다.
- `hashline_edit`: `read`/`edit`를 `LINE#ID` 앵커 방식으로 바꿉니다.

Team 멤버 스펙에 `worktree: true`를 주면 그 멤버는 OpenCode의 네이티브 worktree(기본 위치 `<프로젝트>/.omo/worktrees`)에서 격리되어 작업합니다. 이 경로는 `.git/info/exclude`에 추가되어 리더의 커밋에 섞이지 않습니다. 리더가 멤버의 변경을 통합하며, `team_delete`는 변경이 남은 worktree를 지우지 않고 경로를 알려 줍니다.

## 실행 흐름

- 일반 작업은 Sisyphus 또는 Hephaestus에서 시작합니다. Explore·Librarian의 조사, Junior의 구현, Oracle의 검토 결과를 부모 대화에서 이어받습니다.
- 계획 작업은 Prometheus에서 시작하고, 계획이 준비되면 `/ulw-execute`로 Atlas 실행 흐름에 진입합니다. 최종 검토 결과와 사용자의 완료 승인을 구분합니다.
- `/hyperplan`은 Team 역할별 대화와 공유 작업을 사용합니다. 이 어댑터의 Team 멤버는 같은 프로젝트의 개별 네이티브 세션에서 실행됩니다.
- `/stop-continuation`은 해당 세션의 자동 작업 재개를 중지합니다.

## 도구가 보이지 않을 때

OpenCode v2의 제한적 권한 설정은 복수형 `permissions` 배열을 사용합니다. 구형 단수형 `permission`의 `task`는 호스트가 `subagent`로 변환하므로, 전체 거부 규칙과 함께 쓰면 OMO의 별도 `task`·`look_at` 도구가 숨겨질 수 있습니다. v2 규칙에서는 필요한 `task`와 `subagent` 권한을 각각 지정합니다.

MCP 도구는 기본적으로 네이티브 CodeMode를 통해 노출됩니다. `execute`와 해당 MCP 동작 권한이 모두 필요합니다. 권한 동작 이름은 실제 등록된 도구 목록에서 확인합니다. 도구를 표시하기 위해 기존의 전체 거부 정책을 전체 허용으로 바꾸지는 마세요.

## 업데이트

이 저장소에서 `git pull --ff-only` 후 `bun install --ignore-scripts --frozen-lockfile`, 설치 명령을 다시 실행합니다. 실행 중인 OpenCode를 재시작해 새 플러그인을 불러옵니다. 업스트림 npm 설치 명령은 이 포크의 로컬 빌드를 업데이트하지 않습니다.
