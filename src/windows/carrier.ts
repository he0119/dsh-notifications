/**
 * Windows 原生通知的载体：一个宿主实例一份，与页面导航无关。
 *
 * `src/windows/` 是本包唯一按操作系统分开的一层。目录按 OS 分的意义在于「还有谁实现同一个接口」——
 * 现在只有 Windows 一家，其余平台走浏览器通知；将来加 macOS / Linux 的原生载体时，在旁边放同级实现，
 * 不要另起一个 `src/platform/`（DSH 里 `platform` 指客户端平台 `web`，不是操作系统）。
 * 「点通知回到桌面」那个动作不属于某个系统，所以入口留在 `src/activation.ts`。
 */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  NOTIFICATION_ACTIVATION_PATH,
  NOTIFICATION_ACTIVATION_PREFIX,
  NOTIFICATION_APP_ID,
  NOTIFICATION_GROUP,
  NOTIFICATION_OWNER_NAME,
  NOTIFICATION_OWNER_VALUE,
  NOTIFICATION_PROTOCOL,
  NOTIFICATION_REGISTRY_KEY,
  REMOVE_SCRIPT,
  SETUP_SCRIPT,
  SHOW_SCRIPT,
} from './scripts.ts'
import { LAUNCHER_DIRECTORY_NAME, LAUNCHER_SOURCE, LAUNCHER_SOURCE_VERSION, launcherSourceHash, windowsLauncherFiles, type WindowsLauncherFiles } from './launcher.ts'

/** One logical popup owned by the Host; the id is an opaque stable domain key. */
export interface WindowsNotificationRequest { readonly id: string; readonly title: string; readonly body: string }
/** Host-owned activation sinks; neither may block the other. */
export interface WindowsNotificationDeps {
  /** Restore the desktop window without assuming renderer navigation. */
  readonly activateDesktop: () => Promise<boolean>
  /** Receive the original logical id after a validated, single-use protocol activation. */
  readonly onActivate: (id: string) => void
}
export interface WindowsPowerShellResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
/** One fixed script with a JSON stdin payload; never a shell command line. */
export type WindowsPowerShellExec = (script: string, stdin: string) => Promise<WindowsPowerShellResult>
/** Production callers omit every option; these seams exist for behavior tests. */
export interface WindowsNotificationOptions {
  readonly platform?: string
  readonly localAppData?: string
  readonly execPowerShell?: WindowsPowerShellExec
  readonly now?: () => number
  readonly onWarning?: (message: string) => void
}
export interface WindowsNotificationCarrier {
  /** True only on win32; every other platform is inert without spawning or writing. */
  readonly supported: boolean
  show(request: WindowsNotificationRequest): Promise<boolean>
  close(id: string): Promise<void>
  dispose(): Promise<void>
}

interface Ticket { readonly id: string; readonly tag: string; readonly expires: number; activated?: boolean }

const ticketPattern = /^[0-9a-f]{64}$/
const maxTickets = 256
const ticketLifetime = 24 * 60 * 60 * 1000
const scriptTimeout = 20_000
const responseText: Readonly<Record<number, string>> = { 403: 'forbidden', 404: 'not-found', 405: 'method-not-allowed', 500: 'error' }

function quote(value: string): string {
  return '"' + value + '"'
}

function powerShellPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function powerShellEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    result[key] = value
  }
  return result
}

function runPowerShell(script: string, stdin: string): Promise<WindowsPowerShellResult> {
  return new Promise(resolve => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(powerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: powerShellEnvironment(process.env),
    })
    let stdout = '', stderr = '', settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    timer = setTimeout(() => { child.kill(); finish(null) }, scriptTimeout)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < 4096) stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 4096) stderr += chunk })
    child.once('error', () => finish(null))
    child.once('close', code => finish(code))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdin)
  })
}

async function ensureSafeDirectory(root: string, segments: readonly string[]): Promise<string | undefined> {
  const rootInfo = await lstat(root).catch(() => undefined)
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    let info: Stats | undefined = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (info === undefined) {
      await mkdir(current)
      info = await lstat(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
  }
  return current
}

async function safeTarget(target: string): Promise<boolean> {
  try {
    const info = await lstat(target)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

async function writeStableFile(target: string, content: string): Promise<void> {
  let existing: Stats | undefined
  try {
    existing = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('unsafe-target')
    if (await readFile(target, 'utf8') === content) return
  }
  const temporary = target + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function prepareLauncherSource(root: string, files: WindowsLauncherFiles): Promise<boolean> {
  if (await ensureSafeDirectory(root, ['DshNotifications', 'Notifications', LAUNCHER_DIRECTORY_NAME]) === undefined) return false
  for (const target of [files.executable, files.source, files.hash]) {
    if (!await safeTarget(target)) return false
  }
  await writeStableFile(files.source, LAUNCHER_SOURCE)
  const written = await lstat(files.source)
  return written.isFile() && !written.isSymbolicLink()
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') : ''
}

function buildToastXml(launch: string, title: string, body: string): string {
  const heading = cleanText(title), detail = cleanText(body)
  return '<toast activationType="protocol" launch="' + escapeXml(launch) + '"><visual><binding template="ToastGeneric"><text>' + escapeXml(heading) + '</text>' + (detail.length === 0 ? '' : '<text>' + escapeXml(detail) + '</text>') + '</binding></visual><audio silent="true"/></toast>'
}

/**
 * Create one owner-scoped Windows toast carrier. Native registration and the loopback listener are
 * lazy, so a non-Windows Host and a never-showing profile remain side-effect free.
 */
export function createWindowsNotifications(deps: WindowsNotificationDeps, options: WindowsNotificationOptions = {}): WindowsNotificationCarrier {
  const supported = (options.platform ?? process.platform) === 'win32'
  const execPowerShell = options.execPowerShell ?? runPowerShell
  const clock = options.now ?? Date.now
  const warn = options.onWarning ?? (() => undefined)
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA
  const tickets = new Map<string, Ticket>()
  const ticketsById = new Map<string, string>()
  const ownedTags = new Set<string>()
  const sending = new Map<string, { cancelled: boolean }>()
  const pending = new Set<Promise<void>>()
  let server: Server | undefined
  let port = 0
  let listener: Promise<boolean> | undefined
  let install: Promise<boolean> | undefined
  let installed = false, refused = false, disposed = false

  const dropTicket = (ticket: string): void => {
    const entry = tickets.get(ticket)
    if (entry === undefined) return
    tickets.delete(ticket)
    if (ticketsById.get(entry.id) === ticket) ticketsById.delete(entry.id)
  }

  const removeTags = async (tags: readonly string[]): Promise<boolean> => {
    if (tags.length === 0) return true
    try {
      const result = await execPowerShell(REMOVE_SCRIPT, JSON.stringify({ aumid: NOTIFICATION_APP_ID, group: NOTIFICATION_GROUP, tags }))
      if (result.code !== 0) { warn('toast-remove-failed'); return false }
      for (const tag of tags) ownedTags.delete(tag)
      return true
    } catch (_error) {
      warn('toast-remove-failed')
      return false
    }
  }

  const pruneTickets = (): void => {
    const current = clock()
    for (const [ticket, entry] of [...tickets]) {
      if (entry.expires > current) continue
      dropTicket(ticket)
      void removeTags([entry.tag])
    }
    while (tickets.size > maxTickets) {
      const oldest = tickets.keys().next()
      if (oldest.done === true) break
      const entry = tickets.get(oldest.value)
      dropTicket(oldest.value)
      if (entry !== undefined) void removeTags([entry.tag])
    }
  }

  const respond = (response: ServerResponse, status: number): void => {
    if (response.writableEnded) return
    response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
    response.end(responseText[status] ?? '')
  }

  const finishActivation = (ticket: Ticket): void => {
    const task = (async () => {
      const removal = removeTags([ticket.tag])
      if (disposed) { await removal; return }
      const restore = (async () => deps.activateDesktop())()
      let callback: Promise<void>
      try {
        callback = Promise.resolve(deps.onActivate(ticket.id))
      } catch (error) {
        callback = Promise.reject(error)
      }
      const results = await Promise.allSettled([restore, callback, removal])
      if (results[0]?.status === 'rejected' || (results[0]?.status === 'fulfilled' && results[0].value === false)) warn('desktop-activation-failed')
      if (results[1]?.status === 'rejected') warn('activation-callback-failed')
    })()
    pending.add(task)
    void task.catch(() => undefined).finally(() => { pending.delete(task) })
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== 'POST') { respond(response, 405); return }
      const remote = request.socket.remoteAddress
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') { respond(response, 403); return }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.search.length > 0 || !url.pathname.startsWith(NOTIFICATION_ACTIVATION_PATH)) { respond(response, 404); return }
      const ticket = url.pathname.slice(NOTIFICATION_ACTIVATION_PATH.length)
      if (!ticketPattern.test(ticket)) { respond(response, 404); return }
      const entry = tickets.get(ticket)
      if (entry === undefined || entry.expires <= clock() || disposed) {
        if (entry !== undefined) dropTicket(ticket)
        respond(response, 404)
        return
      }
      entry.activated = true
      dropTicket(ticket)
      respond(response, 202)
      finishActivation(entry)
    } catch (_error) {
      warn('activation-request-failed')
      respond(response, 500)
    } finally {
      request.resume()
    }
  }

  const openListener = async (): Promise<boolean> => {
    if (server !== undefined) return true
    if (disposed) return false
    const candidate = createServer((request, response) => { void handleRequest(request, response) })
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once('error', reject)
        candidate.listen(0, '127.0.0.1', () => { candidate.removeListener('error', reject); resolve() })
      })
      const address = candidate.address()
      if (address === null || typeof address === 'string') throw new Error('loopback-address')
      if (disposed) { candidate.close(); return false }
      candidate.unref()
      port = address.port
      server = candidate
      return true
    } catch (_error) {
      try { candidate.close() } catch (_closeError) { /* never listening */ }
      warn('notification-listener-failed')
      return false
    }
  }

  const ensureListener = async (): Promise<boolean> => {
    if (server !== undefined) return true
    listener ??= openListener()
    try { return await listener } finally { listener = undefined }
  }

  const installCarrier = async (): Promise<boolean> => {
    if (installed) return true
    if (refused) return false
    if (!supported || localAppData === undefined || localAppData.length === 0) return false
    const files = windowsLauncherFiles(localAppData)
    try {
      if (!await prepareLauncherSource(localAppData, files)) { warn('launcher-source-refused'); return false }
    } catch (_error) {
      warn('launcher-source-failed')
      return false
    }
    const command = quote(files.executable) + ' "%1"'
    const payload = JSON.stringify({ keyPath: NOTIFICATION_REGISTRY_KEY, markerName: NOTIFICATION_OWNER_NAME, markerValue: NOTIFICATION_OWNER_VALUE, displayName: 'URL:' + NOTIFICATION_PROTOCOL, command, launcherDirectory: files.directory, launcherPath: files.executable, sourcePath: files.source, hashPath: files.hash, sourceHash: launcherSourceHash(), sourceVersion: LAUNCHER_SOURCE_VERSION })
    try {
      const result = await execPowerShell(SETUP_SCRIPT, payload)
      if (result.code === 0) { installed = true; return true }
      if (result.code === 2) { refused = true; warn('protocol-owner-refused'); return false }
    } catch (_error) { /* reported below without user content */ }
    warn('protocol-registration-failed')
    return false
  }

  const ensureInstalled = async (): Promise<boolean> => {
    if (installed) return true
    if (refused) return false
    install ??= installCarrier()
    try { return await install } finally { install = undefined }
  }

  const show = async (request: WindowsNotificationRequest): Promise<boolean> => {
    if (!supported || disposed) return false
    if (typeof request.id !== 'string' || request.id.length === 0) return false
    const operation = { cancelled: false }
    const prior = sending.get(request.id)
    if (prior) prior.cancelled = true
    sending.set(request.id, operation)
    try {
    if (!await ensureInstalled()) return false
    if (disposed || operation.cancelled) return false
    if (!await ensureListener()) return false
    if (disposed || operation.cancelled) return false
    const previousTicket = ticketsById.get(request.id)
    if (previousTicket !== undefined) {
      const previous = tickets.get(previousTicket)
      dropTicket(previousTicket)
      if (previous !== undefined) await removeTags([previous.tag])
      if (disposed || operation.cancelled) return false
    }
    const ticket = randomBytes(32).toString('hex')
    const tag = randomUUID().replaceAll('-', '')
    const entry: Ticket = { id: request.id, tag, expires: clock() + ticketLifetime }
    tickets.set(ticket, entry)
    ticketsById.set(request.id, ticket)
    pruneTickets()
    const launch = NOTIFICATION_ACTIVATION_PREFIX + '/' + port + '/' + ticket
    const xml = buildToastXml(launch, request.title, request.body)
    let result: WindowsPowerShellResult
    try {
      result = await execPowerShell(SHOW_SCRIPT, JSON.stringify({ aumid: NOTIFICATION_APP_ID, group: NOTIFICATION_GROUP, tag, xml }))
    } catch (_error) {
      dropTicket(ticket)
      warn('toast-delivery-failed')
      return false
    }
    if (disposed || operation.cancelled || (!tickets.has(ticket) && !entry.activated)) {
      dropTicket(ticket)
      await removeTags([tag])
      return false
    }
    if (result.code !== 0) {
      dropTicket(ticket)
      warn('toast-delivery-failed')
      return false
    }
    if (!entry.activated) ownedTags.add(tag)
    return true
    } finally { if (sending.get(request.id) === operation) sending.delete(request.id) }
  }

  const close = async (id: string): Promise<void> => {
    if (!supported || disposed) return
    const operation = sending.get(id)
    if (operation) operation.cancelled = true
    const ticket = ticketsById.get(id)
    if (ticket === undefined) return
    const entry = tickets.get(ticket)
    dropTicket(ticket)
    if (entry !== undefined) await removeTags([entry.tag])
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    for (const operation of sending.values()) operation.cancelled = true
    const tags = [...ownedTags]
    ownedTags.clear()
    tickets.clear()
    ticketsById.clear()
    const active = server
    server = undefined
    await removeTags(tags)
    if (active !== undefined) {
      active.closeAllConnections()
      await new Promise<void>(resolve => { active.close(() => resolve()) })
    }
    await Promise.allSettled([...pending])
  }

  return { supported, show, close, dispose }
}
