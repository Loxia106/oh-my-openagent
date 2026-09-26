import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { basename, isAbsolute, resolve } from "node:path"
import { z } from "zod"
import type { OhMyOpenCodeConfig, SisyphusTasksConfig } from "../config"
import { createTaskCreateTool, createTaskGetTool, createTaskList, createTaskUpdateTool } from "../tools/task"
import { TaskCreateInputSchema, TaskGetInputSchema, TaskUpdateInputSchema } from "../tools/task/types"
import type { TaskObject } from "../tools/task/types"
import { isTaskSystemEnabled } from "../shared/task-system-enabled"
import type { V2TodoState } from "./task-state"
import { addV2Tool } from "./tool-adapter"

// Never wrap legacy factory args here: those fields are built by the legacy
// @opencode-ai/plugin Zod instance (4.1.x), while the V2 host converts the
// Standard JSON Schema contract using the package-root Zod instance (4.6.x).
const taskInputSchemas = {
  task_create: TaskCreateInputSchema.extend({
    subject: TaskCreateInputSchema.shape.subject.describe("Task subject (required)"),
    description: TaskCreateInputSchema.shape.description.describe("Task description"),
    activeForm: TaskCreateInputSchema.shape.activeForm.describe("Active form (present continuous)"),
    metadata: TaskCreateInputSchema.shape.metadata.describe("Task metadata"),
    blockedBy: TaskCreateInputSchema.shape.blockedBy.describe("Task IDs blocking this task"),
    blocks: TaskCreateInputSchema.shape.blocks.describe("Task IDs this task blocks"),
    repoURL: TaskCreateInputSchema.shape.repoURL.describe("Repository URL"),
    parentID: TaskCreateInputSchema.shape.parentID.describe("Parent task ID"),
  }).omit({ owner: true }),
  task_get: TaskGetInputSchema.extend({
    id: TaskGetInputSchema.shape.id.describe("Task ID to retrieve (format: T-{uuid})"),
  }),
  task_list: z.object({}),
  task_update: TaskUpdateInputSchema.extend({
    id: TaskUpdateInputSchema.shape.id.describe("Task ID (required)"),
    subject: TaskUpdateInputSchema.shape.subject.describe("Task subject"),
    description: TaskUpdateInputSchema.shape.description.describe("Task description"),
    status: TaskUpdateInputSchema.shape.status.describe("Task status"),
    activeForm: TaskUpdateInputSchema.shape.activeForm.describe("Active form (present continuous)"),
    owner: TaskUpdateInputSchema.shape.owner.describe("Task owner (agent name)"),
    addBlocks: TaskUpdateInputSchema.shape.addBlocks.describe("Task IDs to add to blocks (additive, not replacement)"),
    addBlockedBy: TaskUpdateInputSchema.shape.addBlockedBy.describe("Task IDs to add to blockedBy (additive, not replacement)"),
    metadata: TaskUpdateInputSchema.shape.metadata.describe("Task metadata to merge (set key to null to delete)"),
  }).omit({ repoURL: true, parentID: true }),
}

function toTask(value: unknown): TaskObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const task = (value as { task?: unknown }).task
  if (typeof task !== "object" || task === null || Array.isArray(task)) return undefined
  const candidate = task as Partial<TaskObject>
  if (typeof candidate.id !== "string" || typeof candidate.subject !== "string") return undefined
  if (candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "completed" && candidate.status !== "deleted") return undefined
  return candidate as TaskObject
}

async function syncNativeTodo(todos: V2TodoState, sessionID: string, task: TaskObject): Promise<void> {
  await todos.update(sessionID, (current) => {
    const withoutTask = current.filter((todo) => todo.id !== task.id)
    if (task.status === "deleted") return withoutTask
    const priority = task.metadata?.priority
    return [...withoutTask, {
      id: task.id,
      content: task.subject,
      status: task.status === "in_progress" ? "in_progress" : task.status === "completed" ? "completed" : "pending",
      ...(priority === "low" || priority === "medium" || priority === "high" ? { priority } : { priority: "medium" as const }),
    }]
  })
}

function resultContent(value: string | { output: string; metadata?: Record<string, unknown> }) {
  return typeof value === "string" ? { content: value } : { content: value.output, metadata: value.metadata }
}

function isDisabled(config: OhMyOpenCodeConfig, name: string): boolean {
  return config.disabled_tools?.some((entry) => entry.trim().toLowerCase() === name) ?? false
}

function taskConfigForLocation(config: OhMyOpenCodeConfig, directory: string): OhMyOpenCodeConfig {
  const tasks: SisyphusTasksConfig = config.sisyphus?.tasks ?? { claude_code_compat: false }
  const storagePath = tasks.storage_path
  const hasConfiguredListID = Boolean(tasks.task_list_id?.trim())
  const hasEnvironmentListID = Boolean(
    process.env.ULTRAWORK_TASK_LIST_ID?.trim() || process.env.CLAUDE_CODE_TASK_LIST_ID?.trim(),
  )
  const normalizedTasks = {
    ...tasks,
    ...(storagePath && !isAbsolute(storagePath) ? { storage_path: resolve(directory, storagePath) } : {}),
    ...(!storagePath && !hasConfiguredListID && !hasEnvironmentListID ? { task_list_id: basename(directory) } : {}),
  }
  return {
    ...config,
    sisyphus: { ...config.sisyphus, tasks: normalizedTasks },
  }
}

/** Reuse the task domain factories; the V2 adapter supplies only the real session ID. */
export function addV2TaskSystemTools(
  editor: ToolEditor,
  config: OhMyOpenCodeConfig,
  todos: V2TodoState,
  directory: string,
): void {
  if (!isTaskSystemEnabled(config)) return
  const locationConfig = taskConfigForLocation(config, directory)
  const factories = {
    task_create: createTaskCreateTool(locationConfig),
    task_get: createTaskGetTool(locationConfig),
    task_list: createTaskList(locationConfig),
    task_update: createTaskUpdateTool(locationConfig),
  }

  for (const name of ["task_create", "task_get", "task_list", "task_update"] as const) {
    if (isDisabled(config, name)) {
      editor.remove(name)
      continue
    }
    const definition = factories[name]
    const input = taskInputSchemas[name]
    addV2Tool(editor, {
      name,
      description: definition.description,
      input,
      options: { codemode: false },
      execute: async (args, context: ToolContext) => {
        // The underlying factories use the session ID, but don't call the V1 client
        // when constructed without PluginInput. This avoids a fake V1 permission/client facade.
        const value = await definition.execute(args as never, { sessionID: context.sessionID } as never)
        if (name === "task_create" || name === "task_update") {
          try {
            if (typeof value === "string") {
              const task = toTask(JSON.parse(value))
              if (task) await syncNativeTodo(todos, context.sessionID, task)
              else if (name === "task_create") {
                const payload = JSON.parse(value) as { task?: { id?: unknown; subject?: unknown } }
                if (typeof payload.task?.id === "string" && typeof payload.task.subject === "string") {
                  await todos.update(context.sessionID, (current) => [...current.filter((todo) => todo.id !== payload.task!.id), {
                    id: payload.task!.id as string,
                    content: payload.task!.subject as string,
                    status: "pending",
                    priority: "medium",
                  }])
                }
              }
            }
          } catch {
            // Preserve the task factory's result if its response isn't a task payload.
          }
        }
        return resultContent(value)
      },
    })
  }
}
