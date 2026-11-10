/**
 * Host half of the quick-actions bundle.
 *
 * Owns two things:
 *   1. the action catalog — groups and the actions inside them (the only place
 *      a new action has to be added, see ACTION_DEFINITIONS below);
 *   2. execution of the `host` actions in the workspace directory.
 *
 * The browser half (client.js) renders the grouped shortcut settings page,
 * listens for the configured keys and posts run requests to these routes.
 * Shortcut bindings themselves live in the browser (localStorage), so the Host
 * never needs a restart when a key changes.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { sep } from 'node:path'

const CATALOG_PATH = '/api/quick-actions/catalog'
const RUN_PATH = '/api/quick-actions/run'

const MAX_BODY_BYTES = 64 * 1024
const MAX_OUTPUT_LINES = 12
const MAX_OUTPUT_LINE_LENGTH = 400
const CUSTOM_COMMAND_TIMEOUT_MS = 120000

/** Settings groups, in display order. Add a group here, then point actions at its id. */
const GROUPS = [
  { id: 'git', order: 10, title: { zh: 'Git', en: 'Git' } },
  { id: 'session', order: 20, title: { zh: '会话与界面', en: 'Session & layout' } },
]

/**
 * The action catalog. `target: 'host'` actions carry a fixed command that runs
 * in the current workspace directory; `target: 'client'` actions are resolved
 * by the browser half through its own service table.
 *
 * A shortcut is stored as canonical tokens: `Mod` is Command on macOS and
 * Control elsewhere, followed by optional `Ctrl` (macOS only), `Alt`, `Shift`
 * and one key name. An empty default means "unbound until the user sets one".
 */
const ACTION_DEFINITIONS = [
  {
    id: 'git.pull',
    group: 'git',
    order: 10,
    target: 'host',
    title: { zh: '拉取最新代码', en: 'Pull latest code' },
    hint: {
      zh: '在当前工作区目录执行 git pull --ff-only（不改写本地提交）',
      en: 'Runs git pull --ff-only in the current workspace (never rewrites local commits)',
    },
    commandLabel: 'git pull --ff-only',
    // Mod+Shift+P is the git-GUI convention for "pull" and, unlike Cmd+T /
    // Cmd+Shift+T, is not reserved by Chromium, Safari or the desktop shell.
    defaultShortcut: { mac: 'Mod+Shift+P', other: 'Mod+Shift+P' },
    command: { bin: 'git', args: ['pull', '--ff-only'], timeoutMs: 120000 },
  },
  {
    id: 'git.fetch',
    group: 'git',
    order: 20,
    target: 'host',
    title: { zh: '抓取远端更新', en: 'Fetch remote updates' },
    hint: {
      zh: '执行 git fetch --all --prune，只更新远端引用，不改动工作区',
      en: 'Runs git fetch --all --prune; remote refs are updated, the worktree is untouched',
    },
    commandLabel: 'git fetch --all --prune',
    defaultShortcut: { mac: '', other: '' },
    command: { bin: 'git', args: ['fetch', '--all', '--prune'], timeoutMs: 120000 },
  },
  {
    id: 'session.new',
    group: 'session',
    order: 10,
    target: 'client',
    clientAction: 'session.new',
    title: { zh: '新建会话', en: 'New session' },
    hint: {
      zh: '打开一个新的空白会话（不切换工作区）',
      en: 'Opens a new blank session without switching workspace',
    },
    commandLabel: '',
    defaultShortcut: { mac: '', other: '' },
  },
  {
    id: 'layout.toggleSidebar',
    group: 'session',
    order: 20,
    target: 'client',
    clientAction: 'layout.toggleSidebar',
    title: { zh: '收起 / 展开侧栏', en: 'Toggle sidebar' },
    hint: {
      zh: '切换左侧栏的显示状态',
      en: 'Collapses or expands the left column',
    },
    commandLabel: '',
    defaultShortcut: { mac: '', other: '' },
  },
]

export const inject = ['webServer']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const serveCatalog = makeCatalogHandler(ctx)
  const serveRun = makeRunHandler(ctx)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: CATALOG_PATH, handler: serveCatalog }),
    'quick-actions catalog route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RUN_PATH, handler: serveRun }),
    'quick-actions run route',
  )
}

/* ------------------------------------------------------------------ routes */

function makeCatalogHandler(ctx) {
  return (req, res) => {
    if (!admitted(ctx, req, res, 'GET')) return
    sendJson(res, 200, catalogPayload(ctx))
  }
}

function makeRunHandler(ctx) {
  return async (req, res) => {
    if (!admitted(ctx, req, res, 'POST')) return
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: '请求内容不是合法的 JSON：' + describe(error) })
      return
    }

    const action = ACTION_DEFINITIONS.find((entry) => entry.id === body.actionId)
    const custom = readCustomCommand(body)
    if (action === undefined && custom === null) {
      sendJson(res, 400, { ok: false, error: '未知的操作：' + String(body.actionId) })
      return
    }
    if (action !== undefined && action.target !== 'host') {
      sendJson(res, 400, { ok: false, error: '该操作由界面执行，Host 不处理：' + action.id })
      return
    }

    const resolved = await resolveDirectory(ctx, body.cwd)
    if (resolved.error !== undefined) {
      sendJson(res, 200, { ok: false, actionId: body.actionId, error: resolved.error })
      return
    }

    const outcome = custom === null
      ? await runCommand(action, resolved.directory)
      : await runShellCommand(custom, resolved.directory)
    sendJson(res, 200, {
      ok: outcome.ok,
      actionId: body.actionId,
      title: action === undefined ? null : action.title,
      custom: custom !== null,
      directory: resolved.directory,
      directorySource: resolved.source,
      output: outcome.output,
      durationMs: outcome.durationMs,
      error: outcome.error,
    })
  }
}

/**
 * A user-defined command arrives with the run request (its only home is the
 * browser's localStorage), so validate the payload before handing it to a shell.
 * The directory guard below still applies: a custom command only ever runs in a
 * registered workspace.
 */
function readCustomCommand(body) {
  const custom = body.custom
  if (custom === null || typeof custom !== 'object') return null
  const command = typeof custom.command === 'string' ? custom.command.trim() : ''
  if (command === '' || command.length > 8000) return null
  if (command.indexOf('\u0000') !== -1) return null
  return command
}

function runShellCommand(command, directory) {
  const platform = process.platform
  const shell = platform === 'win32'
    ? { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
    // A login shell picks up the user's PATH (nvm, Homebrew, pyenv) which a
    // GUI-launched Host does not otherwise have.
    : { bin: process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), args: ['-lc', command] }
  return run(shell.bin, shell.args, directory, CUSTOM_COMMAND_TIMEOUT_MS)
}

/* --------------------------------------------------------------- execution */

function runCommand(action, directory) {
  return run(action.command.bin, action.command.args, directory, action.command.timeoutMs ?? 120000)
}

function run(bin, args, directory, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    execFile(
      bin,
      args,
      {
        cwd: directory,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const output = summarizeOutput(stdout, stderr)
        resolve({
          ok: error == null,
          output,
          durationMs: Date.now() - startedAt,
          error: error == null ? undefined : describeCommandError(error, stderr),
        })
      },
    )
  })
}

function summarizeOutput(stdout, stderr) {
  const text = [String(stdout ?? ''), String(stderr ?? '')].join('\n').trim()
  if (text === '') return ''
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const tail = lines.slice(-MAX_OUTPUT_LINES)
  return tail.map((line) => (line.length > MAX_OUTPUT_LINE_LENGTH ? line.slice(0, MAX_OUTPUT_LINE_LENGTH) + '…' : line)).join('\n')
}

function describeCommandError(error, stderr) {
  if (error && error.code === 'ENOENT') return '未找到要执行的命令（ENOENT），请确认它已安装并在 PATH 中'
  if (error && error.killed) return '命令超时被终止'
  const stderrText = String(stderr ?? '').trim()
  if (stderrText !== '') return stderrText.split(/\r?\n/)[0]
  return error && error.message ? error.message : String(error)
}

/* --------------------------------------------------------------- directory */

async function resolveDirectory(ctx, requested) {
  const roots = registeredWorkspacePaths(ctx)
  const fallback = defaultDirectory(ctx)

  if (typeof requested === 'string' && requested.trim() !== '') {
    const candidate = await existingDirectory(requested.trim())
    if (candidate === null) return { error: '目录不存在：' + requested.trim() }
    const inside = roots.some((root) => isSameOrInside(candidate, root)) || (fallback !== null && isSameOrInside(candidate, fallback))
    if (!inside) {
      return { error: '目录不在已登记的工作区内，已拒绝执行：' + candidate }
    }
    return { directory: candidate, source: 'workspace' }
  }

  if (roots.length === 1) return { directory: roots[0], source: 'workspace' }
  if (fallback !== null) return { directory: fallback, source: 'default' }
  return { error: '未识别到当前工作区目录，请在会话中打开一个工作区后重试' }
}

function registeredWorkspacePaths(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry
      .list()
      .map((workspace) => workspace && workspace.path)
      .filter((path) => typeof path === 'string' && path !== '')
  } catch {
    return []
  }
}

function defaultDirectory(ctx) {
  const workingDirectory = ctx.get('workingDirectory')
  const value = workingDirectory && typeof workingDirectory.defaultDirectory === 'string'
    ? workingDirectory.defaultDirectory
    : ''
  return value === '' ? null : value
}

async function existingDirectory(path) {
  try {
    const info = await stat(path)
    return info.isDirectory() ? path : null
  } catch {
    return null
  }
}

function isSameOrInside(candidate, root) {
  const base = root.endsWith(sep) ? root.slice(0, -1) : root
  return candidate === base || candidate.startsWith(base + sep)
}

/* ----------------------------------------------------------------- payload */

function catalogPayload(ctx) {
  const roots = registeredWorkspacePaths(ctx)
  return {
    version: 1,
    platform: process.platform,
    defaultDirectory: defaultDirectory(ctx),
    workspaces: roots.map((path) => ({ path, title: basename(path) })),
    groups: GROUPS.map((group) => ({ id: group.id, order: group.order, title: group.title })),
    actions: ACTION_DEFINITIONS.map((action) => ({
      id: action.id,
      group: action.group,
      order: action.order,
      target: action.target,
      clientAction: action.clientAction ?? '',
      title: action.title,
      hint: action.hint,
      commandLabel: action.commandLabel,
      defaultShortcut: action.defaultShortcut,
    })),
  }
}

function basename(path) {
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf(sep)
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/* ------------------------------------------------------------------ plumbing */

function admitted(ctx, req, res, method) {
  if (req.method !== method) {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const expected = readWebOrigin(ctx)
    if (expected !== null && origin !== expected) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      return false
    }
  }
  return true
}

function readWebOrigin(ctx) {
  const webServer = ctx.webServer
  if (webServer === undefined || typeof webServer.getOrigin !== 'function') return null
  try {
    return webServer.getOrigin()
  } catch {
    return null
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

function describe(error) {
  return error && error.message ? error.message : String(error)
}
