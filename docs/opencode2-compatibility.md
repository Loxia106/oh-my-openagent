# OpenCode 2.0.18 compatibility (personal fork from upstream 5.0.0)

This fork is based on the upstream Oh My OpenAgent **5.0.0** release, with local native OpenCode 2 compatibility work at the pinned `@opencode/*` **2.0.18** SDK/schema version. The legacy OpenCode 1.x entry remains separate. The v2 adapter is still incomplete; the table is not a claim of full OMO parity or end-to-end verification for every behavior.

The native server entry is `packages/omo-opencode/src/v2/server-entry.ts` and exports the OpenCode 2 plugin definition (`id` plus `setup`). Native registries, tools, and hooks are assembled by `src/v2/setup.ts`. The build stages `server.js`, `tui.js`, shared skill files, and LSP runtime assets under `dist/opencode2/`. The entry bundles externalize `@opencode/*`, OpenTUI, and Solid packages, so this directory is not verified as a relocatable standalone plugin. The installer edits only a user-selected OpenCode config file.

## Hook coverage

Status key: **Ported** means an OMO implementation is registered through the v2 SDK; **Partial** means only a subset of the old behavior is present; **Host candidate** means OpenCode 2 may provide related behavior but exact OMO equivalence has not been verified; **Not ported** means this adapter does not register that hook. The old configuration name is retained in `disabled_hooks` only where listed below.

| `HookNameSchema` entry | V2 status and scope |
| --- | --- |
| `todo-continuation-enforcer` | **Partial.** Native `session.execution.succeeded` terminal events (not `session.idle`) queue continuations for persisted incomplete todos and a basic active Boulder plan. The session location/project is checked before continuation. It respects `/stop-continuation`; legacy retry, cooldown, background-task, and no-progress behavior is not fully ported. |
| `session-notification` | **Not ported.** No matching OMO notification hook is registered. |
| `comment-checker` | **Host candidate.** No OMO hook registration; any host/editor behavior is not asserted as equivalent. |
| `tool-output-truncator` | **Host protection; OMO policy not ported.** OpenCode 2.0.18 bounds local tool text at 2,000 lines / 50 KiB and retains full output. This differs from OMO's dynamic token budget, tighter webfetch cap, and all-tool option. |
| `question-label-truncator` | **Not ported.** |
| `directory-agents-injector` | **Host-owned.** OpenCode loads global/project instructions and injects nested `AGENTS.md` after successful in-project reads as durable session instructions, with history-based deduplication. OMO already skips its legacy injector on supported host versions. The attachment point, truncation, and ordering differ from legacy OMO; this adapter does not inject a second copy. |
| `directory-readme-injector` | **Not ported.** |
| `empty-task-response-detector` | **Not ported.** |
| `think-mode` | **Not ported.** |
| `model-fallback` | **Not ported.** No OMO model fallback controller is wired into the native v2 hooks. |
| `anthropic-context-window-limit-recovery` | **Not ported.** |
| `preemptive-compaction` | **Host protection; OMO policy not ported.** Native auto-compaction checks estimated context before a request and responds to overflow. OMO's after-tool 78% threshold, cooldown, selected compaction model, and recovery behavior are absent. The public v2 plugin session API exposes a compaction hook but no explicit compact operation. |
| `rules-injector` | **Not ported.** |
| `background-notification` | **Host candidate.** Native child sessions are used, but the OMO background notification behavior is not registered. |
| `auto-update-checker` | **Intentionally omitted.** This fork does not run the upstream updater from the incompatible legacy bootstrap. |
| `ast-grep-sg-provision` | **Not ported.** |
| `startup-toast` | **Not ported.** |
| `keyword-detector` | **Partial.** Native prompt/context hooks recognize ultrawork and hyperplan. Hyperplan receives an explicit unavailable notice because the native team manager is not implemented; its team workflow is not simulated. Team prompt injection is suppressed; other keyword actions and legacy hook ordering are not ported. |
| `agent-usage-reminder` | **Not ported.** |
| `non-interactive-env` | **Ported.** The native shell-create hook adds the shared noninteractive environment only when the command contains `git`, preserving unrelated environment entries. |
| `interactive-bash-session` | **Not ported.** The native `shell` tool is used; the legacy persistent interactive-bash session manager is absent. |
| `tool-pair-validator` | **Host protection; historical repair not ported.** The native runner settles failed/interrupted live tool calls and missing hosted results. No equivalent sanitizer for arbitrary malformed historical tool messages was found in the source audit. |
| `monitor-status-injector` | **Not ported.** |
| `goal` | **Partial.** Native lifecycle code accounts usage/time and queues an active-goal continuation after `session.execution.succeeded`. `create_goal`, `update_goal`, and `get_goal` are registered when `goal.enabled` is true. One earlier goal-chain mock fixture passed, but it predates the final location guard; this does not establish full legacy parity. |
| `category-skill-reminder` | **Not ported.** |
| `compaction-context-injector` | **Partial.** Adds active goal and Boulder plan context through the native compaction hook. |
| `compaction-todo-preserver` | **Ported with native storage.** Adds the persisted OMO todo list to compaction context when present. |
| `claude-code-hooks` | **Not ported.** The Claude hook runner and matcher lifecycle are not registered. |
| `auto-slash-command` | **Partial.** The seven built-in OMO commands are registered through the native command API. Discovery of user/project custom OMO command files from the legacy command loader is not ported. `disabled_hooks: ["auto-slash-command"]` does not disable native built-ins; use `disabled_commands` for those. |
| `edit-error-recovery` | **Not ported.** |
| `json-error-recovery` | **Not ported.** |
| `delegate-task-retry` | **Not ported.** Native delegation is present, but legacy retry/recovery behavior is absent. |
| `prometheus-md-only` | **Ported.** Native permission evaluation denies Prometheus edits outside allowed Markdown paths in the workspace `.omo` directory. |
| `sisyphus-junior-notepad` | **Ported for native Atlas task calls.** Adds the append-only notepad and read-only plan directive once to the delegated prompt; the hook is skipped when `task` is disabled. |
| `team-tool-gating` | **Not ported.** Team tools are not registered, and setup disables native team-mode prompts even if `team_mode.enabled` is set. |
| `no-sisyphus-gpt` | **Not ported.** |
| `no-hephaestus-non-gpt` | **Not ported.** Hephaestus model filtering still applies during agent registration, but this hook's runtime fallback behavior is not ported. |
| `hephaestus-agents-md-injector` | **Not ported.** |
| `ulw-execute` | **Partial.** Native `/ulw-execute` switches to Atlas (or Sisyphus when Atlas is absent), reads recent native session context for plan affinity, prepares scoped Boulder/worktree context, and submits one prompt. It does not reproduce every legacy interactive/retry behavior. `disabled_hooks: ["ulw-execute"]` keeps the command/template and agent selection but skips the context/Boulder preparation. |
| `atlas` | **Partial.** On native `session.execution.succeeded`, the adapter completes only the exact Boulder work linked to that session when exactly one active work matches and its non-empty checklist is fully checked. Paused or ambiguous work, empty checklists, stopped sessions, and events for another project/location are skipped; an explicitly configured worktree plan may live outside the project root. A project/session/work-scoped pending marker and stable synthetic ID allow the completion nudge to retry on a later successful execution; a queued marker prevents replay. Stop/disposal while asynchronous checks are pending blocks Boulder status mutation or nudge submission. The complete legacy Atlas controller (descendant/agent eligibility, final-wave approval, background-task retries, cooldown/backoff, and no-progress stall protections) is not ported; storage/admission is not an atomic multi-process transaction. |
| `unstable-agent-babysitter` | **Not ported.** |
| `task-resume-info` | **Ported for native child-session IDs.** Successful task results receive a `task(task_id=...)` resume hint from native result metadata. Resuming with only `task_id` retains the owned child, agent, model, parent, and restrictions. |
| `stop-continuation-guard` | **Partial.** `/stop-continuation` stops native success-triggered continuation; a small set of resume command spellings clears the stop state. |
| `tasks-todowrite-disabler` | **Ported.** When the task system is enabled, native `todoread` returns guidance to use `task_list`/`task_get`; `todowrite` remains available for the live todo panel, matching the legacy policy despite the hook's historical name. |
| `runtime-fallback` | **Not ported.** |
| `write-existing-file-guard` | **Ported.** Rejects writes to existing files until a successful read in that session grants one write. Preserves the legacy explicit `overwrite` and `.omo` exceptions and cross-session invalidation. Failed reads do not grant permission; session deletion clears grants. |
| `notepad-write-guard` | **Ported.** Native tool execution rejects destructive writes to append-only `.omo/notepads` files before the write occurs and returns the guard error to the model. |
| `bash-file-read-guard` | **Not ported.** |
| `hashline-read-enhancer` | **Partial.** Adds hash annotations to native `read` output only when `hashline_edit: true`; does not cover every legacy read path. |
| `read-image-resizer` | **Not ported.** |
| `todo-description-override` | **Not ported.** |
| `webfetch-redirect-guard` | **Not ported.** |
| `fsync-skip-warning` | **Not ported.** |
| `plan-format-validator` | **Not ported.** |
| `legacy-plugin-toast` | **Intentionally omitted.** The v2 setup does not show the legacy-plugin migration notice. |
| `native-edition-nudge` | **Intentionally omitted.** This fork's OpenCode adapter does not show the separate-edition promotion nudge. |

Only the implemented hooks above honor the corresponding `disabled_hooks` values. Unknown/unsupported entries currently have no effect in the native adapter. The legacy `auto-slash-command` file-discovery hook is not ported, and its `disabled_hooks` entry does not remove native built-in commands; `disabled_commands` controls the native command registry.

The host-owned/protection entries are source-audit findings against OpenCode 2.0.18 commit `cd9a14a6b688d4021bee381dfd39d2cef9c0f862`: `packages/core/src/tool/plugin/read.ts`, `session/instructions.ts`, `tool-output.ts`, `session/runner/step.ts`, and `session/compaction.ts`. They do not establish identical OMO behavior. Disabling an OMO hook does not disable these independent host facilities.

## Native built-in commands

The native command registry exposes these seven OMO built-ins: `/goal`, `/refactor`, `/ulw-execute`, `/stop-continuation`, `/remove-ai-slops`, `/handoff`, and `/hyperplan`. `disabled_commands` filters them before registration. OpenCode's own commands such as `/init` and `/review` are host commands, not part of this OMO list.

| Command | Native behavior and limits |
| --- | --- |
| `/goal <objective>` | Stores the goal for the current session and submits one native model prompt. It requires `goal.enabled: true`; otherwise the command reports that goal work is disabled. |
| `/goal` / `show`, `pause`, `resume`, `clear` | `show`, `pause`, and `clear` return visible session-scoped notices without starting a model turn. `resume` keeps the stored objective and usage budget, then submits one prompt. When `goal.enabled` is false, show/pause/clear remain available, while set/resume are blocked. `disabled_hooks: ["goal"]` disables automatic goal continuation; it does not remove the command. |
| `/ulw-execute [plan] [flags]` | Selects Atlas, falling back to Sisyphus if Atlas is unavailable; switches the current session agent, prepares plan/context/Boulder information, then submits one prompt. Plan discovery reads native session history and project plan files. The legacy retry/controller behavior is not fully ported. |
| `/stop-continuation` | Stops continuation and clears the goal only for the current session. Shared project Boulder state and todos are preserved. A visible notice is delivered without starting another model turn. |
| `/refactor`, `/remove-ai-slops`, `/handoff` | Registered native built-in prompt templates; their invocation uses the native command API and one prompt submission. |
| `/hyperplan` | Returns an explicit unavailable notice because the OMO Team Mode runtime is not implemented in this adapter. |

Native command results use a synthetic, non-resuming session message and a tagged TUI toast. The command QA verified visible `/goal` status/pause and `/stop-continuation` notices without extra model turns; unit tests cover `/goal clear` and disabled-command/goal gates. The native registry does not discover OMO custom command files from user/project or Claude Code command directories, so this port does not claim custom-command discovery parity.

## Tools and configuration gates

The legacy inventory below comes from `src/plugin/tool-registry-core-tools.ts`, `tool-registry-gated-tools.ts`, and `tool-registry-team-tools.ts`. The v2 adapter registers only the tools explicitly listed as native below; it does not boot the full v1 managers or their filesystem-backed session facade.

| Legacy tools | Legacy gate | V2 behavior |
| --- | --- | --- |
| `grep`, `glob` | Always, then `disabled_tools` filtering | OpenCode 2.0.18 host built-ins (`packages/core/src/tool/plugin/grep.ts` and `glob.ts`); OMO does not replace them. They remain subject to the v2 `disabled_tools` guard. |
| `session_list`, `session_read`, `session_search`, `session_info` | Always, then `disabled_tools` | Native tools with the same names are registered. Listing/search are limited to current, observed, and OMO child sessions; the complete legacy project-wide history scan is not available through the public v2 plugin API. |
| `background_output`, `background_cancel` | Always, then `disabled_tools` | Native child-session tools are registered. They take native session IDs; legacy `bg_*` task IDs are not supported. |
| `call_omo_agent` | Always, then `disabled_tools` | Native alias is registered for only `explore` and `librarian`. |
| `look_at` | Omitted when `multimodal-looker` is in `disabled_agents`; then `disabled_tools` | Native adapter validates local paths through the host `read` tool and invokes `multimodal-looker` in an owned child session. Inline base64 image/PDF input is materialized in a temporary directory. Other file types are rejected. |
| `task` | Always, then `disabled_tools` | Native delegation uses OpenCode's `subagent` implementation and OMO's visible agent/category config. The runtime fixtures confirmed successful initial delegation and resume using only `task_id`; the same child session, agent, model, parent, and restrictions are retained. Background runs produce child session IDs. |
| `skill_mcp` | Always, then `disabled_tools` | Registered when `claude_code.mcp` is not false. It uses each skill's original MCP server name so `mcp_name` and native permission rules remain applicable. Same-name servers with different configs fail explicitly; identical declarations share the native project-scoped server lifetime, not per-skill isolation. Tool/resource calls use native MCP APIs; MCP prompts remain unsupported by the v2 plugin API. |
| `skill` | Always, then `disabled_tools` | Native skill alias accepts `id` or `name`, and executes the host skill loader. `disabled_skills` is checked during delegated skill loading. |
| `create_goal`, `update_goal`, `get_goal` | `goal.enabled`, then `disabled_tools` | Registered when enabled and operate on the actual native tool-call session. Goal persistence/continuation also uses the native terminal-success lifecycle; an earlier bounded goal-chain mock run is recorded separately from the final todo/Boulder run below. Broader behavioral parity remains unverified. |
| `interactive_bash` | Only if `isInteractiveBashEnabled()` detects its runtime prerequisites, then `disabled_tools` | Not registered; native `shell`/`bash` alias does not provide a persistent tmux session. |
| `task_create`, `task_get`, `task_list`, `task_update` | `experimental.task_system: true`, then `disabled_tools` | Native tools use schemas compatible with the host's Standard JSON Schema conversion. A real-host fixture verifies that all four tools are model-visible, create/get/list/update execute, the task persists, and create/update synchronize OMO todo state. Earlier mixed-version Zod schemas silently dropped three tools; that defect is fixed. |
| `edit` hashline replacement | `hashline_edit: true`, then `disabled_tools` | V2 keeps native `edit` and adds `hashline_edit`; exact legacy replacement semantics and all fallback paths are not reproduced. |
| `monitor_start`, `monitor_stop`, `monitor_list`, `monitor_output` | `monitor.enabled: true` and a monitor manager, then `disabled_tools` | Not registered. |
| `team_create`, `team_delete`, `team_shutdown_request`, `team_approve_shutdown`, `team_reject_shutdown`, `team_send_message`, `team_task_create`, `team_task_list`, `team_task_update`, `team_task_get`, `team_status`, `team_list` | `team_mode.enabled: true`, then `disabled_tools` | Not registered; setting `team_mode.enabled` does not enable native Team Mode yet. |

The v2 adapter additionally creates `todowrite` and `todoread`, compatibility aliases `bash`→native `shell` and `apply_patch`→native `patch`, and path-form wrappers for native `read`, `edit`, and `write`. `disabled_tools` removes the corresponding aliases/wrappers. When old permission aliases collapse to one native action (for example `write` and `edit` both map to `edit`), conflicting rules resolve conservatively (`deny` > `ask` > `allow`) and emit a diagnostic; this can be stricter than an old per-tool rule. The 2.0.18 runtime fixture confirms root-level `shell: deny` and `edit: deny` are present on OMO Sisyphus and that a shell call is denied without creating its side-effect file.

## Other known gaps

- Built-in OMO agents and model/provider selection use the native agent/model registries. Custom agents from user/project Claude agent directories, `agent_definitions`, and prompt-bearing unified `config.agents` entries are merged and registered; built-in IDs remain owned by OMO and host-defined OpenCode agents remain host-owned. `claude_code.agents: false` and `disabled_agents` are applied.
- Skills are loaded into the native registry and are model-visible by default. Claude `disable-model-invocation: true` and native `metadata.opencode/autoinvoke: false` suppress automatic discovery while leaving explicit invocation available. Because the host can register internal skill transforms after user plugins, OMO also listens for location-scoped `skill.updated` events and appends a policy-only correction if a later transform overrides invocation visibility or re-adds a disabled skill. Native agent prompt factories also filter manual-only skills and built-in team skills that this adapter cannot support, while preserving non-builtin skills with the same names. Unit tests cover late overrides, disabled skills, correction-loop prevention, and cleanup; the runtime fixture confirms `qa-manual-only`, `security-research`, `security-review`, and `team-mode` are absent from every model system prompt, not only the `<available_skills>` block. This is event-driven startup reconciliation, not a synchronous guarantee before every first registry read.
- MCP defaults and Claude Code MCP servers are translated to native config. Registry tests cover preservation of native auth/disabled values and explicit `disabled_mcps` removal. The skill MCP adapter keeps original server names for permission compatibility; conflicts and the shared project-scoped lifetime are described in the tool table above.
- OpenCode 2.0.18 does not automatically copy `Agent.Info.request.settings` into the provider request. OMO stores flat `providerOptions` there before mapped top-level fields, then applies the existing `options` object last; its native context hook copies the result to `SessionContext.options`, where the host routes unknown keys through the selected provider. A separate isolated 2.0.18 local-mock fixture with the OMO plugin alone verifies `reasoningEffort` reaches the wire as `reasoning_effort` for built-in Sisyphus and a prompt-bearing custom `api-builder`; top-level temperatures win collisions (`0.31` and `0.42`). OMO options stay out of `request.body`, preserving the host-owned body/header merge path. The focused provider-options fixture passed 12 checks.
- The native TUI setup and status sidebar load in the 2.0.18 PTY fixture. The `/omo-status` dialog and blank `/omo-btw` question dialog rendered and were dismissed with Escape. A submitted BTW question then created a distinct native fork, completed a response in that fork, and left the original parent transcript unchanged. OMO uses `/omo-btw` with `/side` as its alias so OpenCode's native `/btw` remains untouched.

## Verification boundary

The safety/task source checkpoint is `360835f85`, based on the integrated 5.0.0 adapter below. `test:opencode2` passed 164 tests with 666 assertions across 28 files; `typecheck:opencode2` and `build:opencode2` passed. Its server bundle SHA-256 is `423c9ee886f2bf6fc710e00487cf57cba09807a286580907b9c31194b200cdb0`. The isolated OpenCode 2.0.18 mock-host fixture passed 14 checks covering rejected overwrites, one-use successful-read permission, the TodoRead/TodoWrite policy, all four model-visible task tools, persisted task completion, and native todo synchronization. The final host log has no invalid-tool-registration diagnostics. Evidence and source/bundle checksums are under `.omo/evidence/20260927-opencode2-safety/`; earlier fixture counts below belong to their stated checkpoints and were not all repeated on this bundle.

The verified **5.0.0+commands checkpoint** is source commit `891882dacbb05fb5d499c9211c46deb4045ef04a`, whose second parent is upstream release `eb5c55c67877ef58e58a174b4c26d0c3e941eca0`. `bun install --ignore-scripts --frozen-lockfile`, `test:opencode2` (149 tests, 578 assertions across 27 files), `typecheck:opencode2`, `typecheck:script`, and `build:opencode2` passed. The affected ULW, prompt, delegate-category, model-core category, Senpi category, and model-profile suite passed 1,316 tests with 4,120 assertions across 115 files. The checked bundle was built from the exact source tree of that checkpoint: `server.js` SHA-256 `f3bb68d4d64dc3b7e066587e26bab302f9ccbd8862d5d4896febf3f5b05c6ce7`; `tui.js` SHA-256 `f7326484dcfb5ac1965d7cade174e35b0cac64a4c22fac6b956ce0610f0010a6`.

On the 5.0.0+commands bundle, the isolated OpenCode 2.0.18 core runtime fixture passed 28/28 checks, and the native command/PTY fixture passed 18/18 checks. Command evidence confirms Atlas plan/Boulder context, session-scoped stop behavior, goal set/resume prompts, visible status/pause/stop notices, and no additional model turn for informational/status actions. Both QA drivers used evidence-local HOME/XDG roots and explicit isolated `OPENCODE_DB` files, and stopped the server and mock provider. The host's default database path was absent before and after the runs. Full evidence is under `.omo/evidence/20260927-opencode2-upstream-5.0.0/`; see `merge-verification.json`, `core/runtime.json`, `commands/runtime.json`, and `commands/commands-qa-pty.typescript`.

The integrated hook/resume source is merge commit `5fcf92f276a4faeb18577e31756669d784577308`, whose second parent is main commit `e1de138f4f46ffe4e69b60d03c689d105be49024`. On this source tree, `test:opencode2` passed 158 tests with 629 assertions across 27 files; `typecheck:opencode2` and `build:opencode2` passed. The built `server.js` SHA-256 is `d3f1f52d72c383c011b5fcd948c5b41035b28fc25469dc6661bbec5aae1572e6`; `tui.js` SHA-256 is `f7326484dcfb5ac1965d7cade174e35b0cac64a4c22fac6b956ce0610f0010a6`.

On that bundle, the isolated native tool-hook fixture passed 15/15 checks, including the git-only noninteractive environment, append-only notepad write rejection, Atlas directive injection, and native task-resume hint. The task-resume fixture passed 21/21 checks: resuming with only the native child `task_id` reused the same child and retained its agent, model, parent, and restrictions; restricted todo calls remained denied on both turns. Both fixtures stopped their server and mock provider and wrote isolated databases. Evidence is under `.omo/evidence/20260927-opencode2-main-hooks-resume/`, with summaries at `tool-hooks/run-vNEpce/runtime.json` and `task-resume/run-VZYeP8/runtime.json` and command logs beside them.

Those 28 core checks verified agent registry loading after prompt activation, root shell/edit denial with no denied side effect, native read and todo operations, context injection, the three request settings above, automatic skill visibility and model-invocation policy, team-prompt suppression, and successful native `task` delegation to `explore` with matching parent and observed output. The real PTY run loaded the TUI plugin/sidebar, rendered the status dialog, opened and canceled the empty BTW dialog, then submitted a BTW question. The new fork's `fork_session_id` matched the original session, its transcript contained both the question and mock response, the original parent transcript was unchanged, and the project session count changed from 2 to 3 with one additional mock-provider call. It did not inspect the real user database. Cleanup confirmed both the OpenCode child and mock provider stopped. This evidence does not establish full behavior parity. Unit tests cover individual registry transforms, custom-agent loading, skill policy reconciliation, MCP conflict behavior, and tool adapters, but do not replace remaining feature-specific end-to-end checks; see the `core/runtime.json` and `tui-pty.json` captures cited above.

An earlier integrated `test:opencode2` snapshot passed 109 tests with 352 assertions; the raw-prompt route audit passed 10 tests, and `typecheck:opencode2`, `typecheck:script`, and the native build also passed. Its verification snapshot is `.omo/evidence/20260927-opencode2/runtime-btw-final2/` (`QA-SUMMARY.md`, `runtime.json`, `tui-pty.json`, mock-request data, and build/test/typecheck/audit logs). It predates the lifecycle changes in this section and is not the current lifecycle test count.

The lifecycle-specific OpenCode 2.0.18 local-mock run is `.omo/evidence/20260927-opencode2/boulder-runtime-native-todo-final/run-hW58sd/`. Its 16 checks passed: the host emitted `session.execution.succeeded`; the adapter completed the matching Boulder once, left an unrelated paused work intact, queued one nudge, then continued a pending todo through native `todowrite` calls and stopped after the mock completed that todo. The five provider requests showed no continuation loop. The isolated server and mock provider both stopped; the real user database was not inspected. The bundle was built from the working tree at that checkpoint (`server.js` SHA-256 `4f9d5784…d0adeb508673`). Focused lifecycle/Boulder tests passed 20 tests with 90 assertions and `typecheck:opencode2` passed. A separate earlier goal-chain fixture is at `.omo/evidence/20260927-opencode2/boulder-runtime-native-success/run-Pu28Qc/`; that bundle predates the final project/location guard and is not a goal-runtime verification of the final bundle. Neither fixture establishes full legacy Atlas parity.

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
