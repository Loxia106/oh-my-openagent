# OpenCode 2.0 compatibility (personal fork)

This document describes the native plugin adapter in this fork at the pinned `@opencode/*` **2.0.18** SDK/schema version. The legacy OpenCode 1.x entry remains separate. The v2 adapter is an in-progress compatibility layer; it does not provide full OMO parity and this table is not a claim that each behavior has passed an end-to-end runtime test.

The native server entry is `packages/omo-opencode/src/v2/server-entry.ts` and exports the OpenCode 2 plugin definition (`id` plus `setup`). Native registries, tools, and hooks are assembled by `src/v2/setup.ts`. The build stages `server.js`, `tui.js`, shared skill files, and LSP runtime assets under `dist/opencode2/`. The entry bundles externalize `@opencode/*`, OpenTUI, and Solid packages, so this directory is not verified as a relocatable standalone plugin. The installer edits only a user-selected OpenCode config file.

## Hook coverage

Status key: **Ported** means an OMO implementation is registered through the v2 SDK; **Partial** means only a subset of the old behavior is present; **Host candidate** means OpenCode 2 may provide related behavior but exact OMO equivalence has not been verified; **Not ported** means this adapter does not register that hook. The old configuration name is retained in `disabled_hooks` only where listed below.

| `HookNameSchema` entry | V2 status and scope |
| --- | --- |
| `todo-continuation-enforcer` | **Partial.** On successful idle, queues continuation for persisted incomplete todos and an active Boulder plan. Respects `/stop-continuation`; does not reproduce every legacy continuation trigger. |
| `session-notification` | **Not ported.** No matching OMO notification hook is registered. |
| `comment-checker` | **Host candidate.** No OMO hook registration; any host/editor behavior is not asserted as equivalent. |
| `tool-output-truncator` | **Host candidate.** No OMO truncation hook is registered; output bounds/equivalence are unverified. |
| `question-label-truncator` | **Not ported.** |
| `directory-agents-injector` | **Host candidate.** OpenCode's native project instruction/agent context may cover part of this behavior; equivalent directory traversal and prompt ordering are unverified. |
| `directory-readme-injector` | **Not ported.** |
| `empty-task-response-detector` | **Not ported.** |
| `think-mode` | **Not ported.** |
| `model-fallback` | **Not ported.** No OMO model fallback controller is wired into the native v2 hooks. |
| `anthropic-context-window-limit-recovery` | **Not ported.** |
| `preemptive-compaction` | **Host candidate.** The host owns compaction; OMO's preemptive threshold/recovery behavior is not implemented or verified. |
| `rules-injector` | **Not ported.** |
| `background-notification` | **Host candidate.** Native child sessions are used, but the OMO background notification behavior is not registered. |
| `auto-update-checker` | **Intentionally omitted.** This fork does not run the upstream updater from the incompatible legacy bootstrap. |
| `ast-grep-sg-provision` | **Not ported.** |
| `startup-toast` | **Not ported.** |
| `keyword-detector` | **Partial.** Native prompt/context hooks recognize ultrawork and hyperplan. Hyperplan receives an explicit unavailable notice because the native team manager is not implemented; its team workflow is not simulated. Team prompt injection is suppressed; other keyword actions and legacy hook ordering are not ported. |
| `agent-usage-reminder` | **Not ported.** |
| `non-interactive-env` | **Not ported.** |
| `interactive-bash-session` | **Not ported.** The native `shell` tool is used; the legacy persistent interactive-bash session manager is absent. |
| `tool-pair-validator` | **Host candidate.** No OMO repair hook is registered; protocol-level pairing behavior needs runtime trace verification. |
| `monitor-status-injector` | **Not ported.** |
| `goal` | **Partial.** Native lifecycle code persists/continues an existing goal and accounts usage/time. `create_goal`, `update_goal`, and `get_goal` are registered when `goal.enabled` is true; behavior beyond the tested tool paths is not established as full legacy parity. |
| `category-skill-reminder` | **Not ported.** |
| `compaction-context-injector` | **Partial.** Adds active goal and Boulder plan context through the native compaction hook. |
| `compaction-todo-preserver` | **Ported with native storage.** Adds the persisted OMO todo list to compaction context when present. |
| `claude-code-hooks` | **Not ported.** The Claude hook runner and matcher lifecycle are not registered. |
| `auto-slash-command` | **Not ported.** The legacy command discovery is not wired to a v2 server command registry. |
| `edit-error-recovery` | **Not ported.** |
| `json-error-recovery` | **Not ported.** |
| `delegate-task-retry` | **Not ported.** Native delegation is present, but legacy retry/recovery behavior is absent. |
| `prometheus-md-only` | **Ported.** Native permission evaluation denies Prometheus edits outside allowed Markdown paths in the workspace `.omo` directory. |
| `sisyphus-junior-notepad` | **Not ported.** |
| `team-tool-gating` | **Not ported.** Team tools are not registered, and setup disables native team-mode prompts even if `team_mode.enabled` is set. |
| `no-sisyphus-gpt` | **Not ported.** |
| `no-hephaestus-non-gpt` | **Not ported.** Hephaestus model filtering still applies during agent registration, but this hook's runtime fallback behavior is not ported. |
| `hephaestus-agents-md-injector` | **Not ported.** |
| `ulw-execute` | **Not ported.** No native `/ulw-execute` command is registered. |
| `atlas` | **Not ported.** Atlas agent registration exists; the Atlas lifecycle hook behavior is not registered. |
| `unstable-agent-babysitter` | **Not ported.** |
| `task-resume-info` | **Not ported.** |
| `stop-continuation-guard` | **Partial.** `/stop-continuation` stops native idle continuation; a small set of resume command spellings clears the stop state. |
| `tasks-todowrite-disabler` | **Not ported.** Task-system registry exists, but this hook's conditional todo tool policy is not reproduced. |
| `runtime-fallback` | **Not ported.** |
| `write-existing-file-guard` | **Not ported.** |
| `notepad-write-guard` | **Not ported.** |
| `bash-file-read-guard` | **Not ported.** |
| `hashline-read-enhancer` | **Partial.** Adds hash annotations to native `read` output only when `hashline_edit: true`; does not cover every legacy read path. |
| `read-image-resizer` | **Not ported.** |
| `todo-description-override` | **Not ported.** |
| `webfetch-redirect-guard` | **Not ported.** |
| `fsync-skip-warning` | **Not ported.** |
| `plan-format-validator` | **Not ported.** |
| `legacy-plugin-toast` | **Intentionally omitted.** The v2 setup does not show the legacy-plugin migration notice. |
| `native-edition-nudge` | **Intentionally omitted.** This fork's OpenCode adapter does not show the separate-edition promotion nudge. |

Only the implemented hooks above honor the corresponding `disabled_hooks` values. Unknown/unsupported entries currently have no effect in the native adapter.

## Tools and configuration gates

The legacy inventory below comes from `src/plugin/tool-registry-core-tools.ts`, `tool-registry-gated-tools.ts`, and `tool-registry-team-tools.ts`. The v2 adapter registers only the tools explicitly listed as native below; it does not boot the full v1 managers or their filesystem-backed session facade.

| Legacy tools | Legacy gate | V2 behavior |
| --- | --- | --- |
| `grep`, `glob` | Always, then `disabled_tools` filtering | OpenCode 2.0.18 host built-ins (`packages/core/src/tool/plugin/grep.ts` and `glob.ts`); OMO does not replace them. They remain subject to the v2 `disabled_tools` guard. |
| `session_list`, `session_read`, `session_search`, `session_info` | Always, then `disabled_tools` | Native tools with the same names are registered. Listing/search are limited to current, observed, and OMO child sessions; the complete legacy project-wide history scan is not available through the public v2 plugin API. |
| `background_output`, `background_cancel` | Always, then `disabled_tools` | Native child-session tools are registered. They take native session IDs; legacy `bg_*` task IDs are not supported. |
| `call_omo_agent` | Always, then `disabled_tools` | Native alias is registered for only `explore` and `librarian`. |
| `look_at` | Omitted when `multimodal-looker` is in `disabled_agents`; then `disabled_tools` | Native adapter validates local paths through the host `read` tool and invokes `multimodal-looker` in an owned child session. Inline base64 image/PDF input is materialized in a temporary directory. Other file types are rejected. |
| `task` | Always, then `disabled_tools` | Native delegation uses OpenCode's `subagent` implementation and OMO's visible agent/category config. The runtime fixture confirmed a successful `explore` child with the expected parent session and returned output. Background runs produce child session IDs. |
| `skill_mcp` | Always, then `disabled_tools` | Registered when `claude_code.mcp` is not false. It uses each skill's original MCP server name so `mcp_name` and native permission rules remain applicable. Same-name servers with different configs fail explicitly; identical declarations share the native project-scoped server lifetime, not per-skill isolation. Tool/resource calls use native MCP APIs; MCP prompts remain unsupported by the v2 plugin API. |
| `skill` | Always, then `disabled_tools` | Native skill alias accepts `id` or `name`, and executes the host skill loader. `disabled_skills` is checked during delegated skill loading. |
| `create_goal`, `update_goal`, `get_goal` | `goal.enabled`, then `disabled_tools` | Registered when enabled and operate on the actual native tool-call session. Goal persistence/continuation also has native lifecycle hooks; behavioral parity beyond tested create/update/get remains unverified. |
| `interactive_bash` | Only if `isInteractiveBashEnabled()` detects its runtime prerequisites, then `disabled_tools` | Not registered; native `shell`/`bash` alias does not provide a persistent tmux session. |
| `task_create`, `task_get`, `task_list`, `task_update` | `experimental.task_system: true`, then `disabled_tools` | Native tools are registered under the same names when that gate is true. Create/update synchronize OMO todo state; the host task implementation is not a full replacement for every legacy task-system behavior. |
| `edit` hashline replacement | `hashline_edit: true`, then `disabled_tools` | V2 keeps native `edit` and adds `hashline_edit`; exact legacy replacement semantics and all fallback paths are not reproduced. |
| `monitor_start`, `monitor_stop`, `monitor_list`, `monitor_output` | `monitor.enabled: true` and a monitor manager, then `disabled_tools` | Not registered. |
| `team_create`, `team_delete`, `team_shutdown_request`, `team_approve_shutdown`, `team_reject_shutdown`, `team_send_message`, `team_task_create`, `team_task_list`, `team_task_update`, `team_task_get`, `team_status`, `team_list` | `team_mode.enabled: true`, then `disabled_tools` | Not registered; setting `team_mode.enabled` does not enable native Team Mode yet. |

The v2 adapter additionally creates `todowrite` and `todoread`, compatibility aliases `bash`→native `shell` and `apply_patch`→native `patch`, and path-form wrappers for native `read`, `edit`, and `write`. `disabled_tools` removes the corresponding aliases/wrappers. When old permission aliases collapse to one native action (for example `write` and `edit` both map to `edit`), conflicting rules resolve conservatively (`deny` > `ask` > `allow`) and emit a diagnostic; this can be stricter than an old per-tool rule. The 2.0.18 runtime fixture confirms root-level `shell: deny` and `edit: deny` are present on OMO Sisyphus and that a shell call is denied without creating its side-effect file.

## Other known gaps

- Built-in OMO agents and model/provider selection use the native agent/model registries. Custom agents from user/project Claude agent directories, `agent_definitions`, and prompt-bearing unified `config.agents` entries are merged and registered; built-in IDs remain owned by OMO and host-defined OpenCode agents remain host-owned. `claude_code.agents: false` and `disabled_agents` are applied.
- Skills are loaded into the native registry and are model-visible by default. Claude `disable-model-invocation: true` and native `metadata.opencode/autoinvoke: false` suppress automatic discovery while leaving explicit invocation available. Because the host can register internal skill transforms after user plugins, OMO also listens for location-scoped `skill.updated` events and appends a policy-only correction if a later transform overrides invocation visibility or re-adds a disabled skill. Native agent prompt factories also filter manual-only skills and built-in team skills that this adapter cannot support, while preserving non-builtin skills with the same names. Unit tests cover late overrides, disabled skills, correction-loop prevention, and cleanup; the runtime fixture confirms `qa-manual-only`, `security-research`, `security-review`, and `team-mode` are absent from every model system prompt, not only the `<available_skills>` block. This is event-driven startup reconciliation, not a synchronous guarantee before every first registry read.
- MCP defaults and Claude Code MCP servers are translated to native config. Registry tests cover preservation of native auth/disabled values and explicit `disabled_mcps` removal. The skill MCP adapter keeps original server names for permission compatibility; conflicts and the shared project-scoped lifetime are described in the tool table above.
- OpenCode 2.0.18 stores agent request settings in `Agent.Info.request.settings` but does not automatically copy them into the provider request. OMO's native context hook copies them to `SessionContext.options`; the runtime fixture verifies configured `temperature: 0.23`, `topP: 0.61`, and `maxTokens: 317` in the mock provider JSON as `temperature`, `top_p`, and `max_completion_tokens`. Direct agent `providerOptions` currently remain in `Agent.Info.request.body`, which this host version does not consume; they are not forwarded by the adapter yet.
- The native TUI setup and status sidebar load in the 2.0.18 PTY fixture. The `/omo-status` dialog and blank `/omo-btw` question dialog rendered and were dismissed with Escape. A submitted BTW question then created a distinct native fork, completed a response in that fork, and left the original parent transcript unchanged. OMO uses `/omo-btw` with `/side` as its alias so OpenCode's native `/btw` remains untouched.

## Verification boundary

The OpenCode 2.0.18 local-mock runtime fixture passed all 28 checks. It verified agent registry loading after prompt activation, root shell/edit denial with no denied side effect, native read and todo operations, context injection, the three request settings above, automatic skill visibility and model-invocation policy, team-prompt suppression, and successful native `task` delegation to `explore` with matching parent and observed output. The real PTY run loaded the TUI plugin/sidebar, rendered the status dialog, opened and canceled the empty BTW dialog, then submitted a BTW question. The new fork's `fork_session_id` matched the original session, its transcript contained both the question and mock response, the original parent transcript was unchanged, and the project session count changed from 2 to 3 with one additional mock-provider call. It did not inspect the real user database. Cleanup confirmed both the OpenCode child and mock provider stopped. This evidence does not establish full behavior parity. Unit tests cover individual registry transforms, custom-agent loading, skill policy reconciliation, MCP conflict behavior, and tool adapters, but do not replace remaining feature-specific end-to-end checks.

The final `test:opencode2` run passed 109 tests with 352 assertions; the raw-prompt route audit passed 10 tests, and `typecheck:opencode2`, `typecheck:script`, and the native build also passed. The verification snapshot is `.omo/evidence/20260927-opencode2/runtime-btw-final2/` (`QA-SUMMARY.md`, `runtime.json`, `tui-pty.json`, mock-request data, and build/test/typecheck/audit logs). It used the official v2.0.18 host with a local mock provider and isolated data paths. These checks complement the runtime fixture and do not establish full legacy parity.

## Local fork installation

Use the `codex/opencode2-compat` branch as source and choose an explicit project or config directory. The installer writes an absolute plugin-directory entry and sets `default_agent` to `sisyphus` only when it is absent; it backs up an existing config before editing it.

```sh
git clone --branch codex/opencode2-compat https://github.com/Loxia106/oh-my-openagent.git
cd oh-my-openagent
bun install --ignore-scripts
bun run build:opencode2
bun run install:opencode2 -- --project /path/to/project
# or: bun run install:opencode2 -- --config-dir /path/to/opencode-config
```

This workflow targets OpenCode 2.0.18. It is not the upstream npm installer. Do not interpret passing unit/type/build checks as full behavior parity; use the compatibility table and runtime evidence for the exact build under test.

The installer records an absolute path to this checkout's `dist/opencode2/`. Keep the cloned source checkout and its `node_modules` in place so OpenCode can resolve the external SDK/UI packages and the staged file-backed skill/LSP assets. If the checkout moves, rebuild and rerun the installer for the new path; copying `dist/opencode2/` alone is unsupported.
