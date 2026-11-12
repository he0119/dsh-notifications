/** Behavior tests for the Windows protocol toast carrier; PowerShell and the desktop are mocked. */
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowsNotifications, type WindowsNotificationCarrier, type WindowsNotificationOptions, type WindowsPowerShellResult } from '../src/windows/carrier.ts'
import {
  NOTIFICATION_ACTIVATION_PATH,
  NOTIFICATION_APP_ID,
  NOTIFICATION_GROUP,
  NOTIFICATION_OWNER_NAME,
  NOTIFICATION_OWNER_VALUE,
  NOTIFICATION_REGISTRY_KEY,
  REMOVE_SCRIPT,
  SETUP_SCRIPT,
  SHOW_SCRIPT,
} from '../src/windows/scripts.ts'
import { LAUNCHER_SOURCE, launcherSourceHash, windowsLauncherFiles } from '../src/windows/launcher.ts'

interface ExecCall { readonly script: string; readonly stdin: string }
type ExecHandler = (call: ExecCall) => Partial<WindowsPowerShellResult> | undefined

function createExec(handler?: ExecHandler) {
  const calls: ExecCall[] = []
  const execPowerShell = vi.fn(async (script: string, stdin: string): Promise<WindowsPowerShellResult> => {
    const call: ExecCall = { script, stdin }
    calls.push(call)
    const override = handler?.(call)
    return { code: 0, stdout: '', stderr: '', ...(override ?? {}) }
  })
  return { calls, execPowerShell }
}

const roots: string[] = []
const carriers: WindowsNotificationCarrier[] = []

afterEach(async () => {
  await Promise.allSettled(carriers.splice(0).map(carrier => carrier.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function rootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cyaness-windows-'))
  roots.push(root)
  return root
}

async function localDir(): Promise<string> {
  const local = join(await rootDir(), 'Local')
  await mkdir(local)
  return local
}

function createCarrier(execPowerShell: ReturnType<typeof createExec>['execPowerShell'], localAppData: string, extra: Partial<WindowsNotificationOptions> = {}, deps: { activateDesktop?: () => Promise<boolean>; onActivate?: (id: string) => void } = {}): WindowsNotificationCarrier {
  const carrier = createWindowsNotifications({
    activateDesktop: deps.activateDesktop ?? (async () => true),
    onActivate: deps.onActivate ?? (() => undefined),
  }, { platform: 'win32', localAppData, execPowerShell, ...extra })
  carriers.push(carrier)
  return carrier
}

function show(id = 'owner-1:notification-1', title = 'Completed', body = 'A session finished'): { id: string; title: string; body: string } {
  return { id, title, body }
}

function showCalls(calls: readonly ExecCall[]): ExecCall[] {
  return calls.filter(call => call.script === SHOW_SCRIPT)
}

function setupCalls(calls: readonly ExecCall[]): ExecCall[] {
  return calls.filter(call => call.script === SETUP_SCRIPT)
}

function removeCalls(calls: readonly ExecCall[]): ExecCall[] {
  return calls.filter(call => call.script === REMOVE_SCRIPT)
}

function parseShow(call: ExecCall) {
  const payload = JSON.parse(call.stdin) as { aumid: string; group: string; tag: string; xml: string }
  const launch = /launch="([^"]+)"/.exec(payload.xml)?.[1]
  if (launch === undefined) throw new Error('toast launch is missing')
  const match = /^dsh-notifications:\/\/activate\/(\d+)\/([0-9a-f]{64})$/.exec(launch)
  if (match === null) throw new Error('toast launch is not the fixed activation shape')
  return { payload, launch, port: Number(match[1]), ticket: match[2] as string }
}

function activationUrl(port: number, ticket: string): string {
  return 'http://127.0.0.1:' + port + NOTIFICATION_ACTIVATION_PATH + ticket
}

async function postActivation(port: number, ticket: string): Promise<Response> {
  return fetch(activationUrl(port, ticket), { method: 'POST' })
}

describe('createWindowsNotifications', () => {
  it('is inert off Windows without spawning or writing', async () => {
    const local = await localDir()
    const { execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local, { platform: 'linux' })
    expect(carrier.supported).toBe(false)
    await expect(carrier.show(show())).resolves.toBe(false)
    await carrier.close('owner-1:notification-1')
    await carrier.dispose()
    expect(execPowerShell).not.toHaveBeenCalled()
    await expect(stat(join(local, 'DshNotifications'))).rejects.toThrow()
  })

  it('registers once, writes the stable helper, and shows a protocol toast through stdin only', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local)
    const title = '<完成> & "quoted"'
    const body = '正文 <b> & more'
    await expect(carrier.show({ id: 'owner-1:notification-1', title, body })).resolves.toBe(true)

    const setups = setupCalls(calls)
    expect(setups).toHaveLength(1)
    const files = windowsLauncherFiles(local)
    const setup = JSON.parse(setups[0]!.stdin) as { keyPath: string; markerName: string; markerValue: string; displayName: string; command: string; launcherDirectory: string; launcherPath: string; sourcePath: string; hashPath: string; sourceHash: string }
    expect(setup.keyPath).toBe(NOTIFICATION_REGISTRY_KEY)
    expect(setup.markerName).toBe(NOTIFICATION_OWNER_NAME)
    expect(setup.markerValue).toBe(NOTIFICATION_OWNER_VALUE)
    expect(setup.displayName).toBe('URL:dsh-notifications')
    expect(setup.command).toBe('"' + files.executable + '" "%1"')
    expect(setup.command).toContain('activate.exe')
    expect(setup.command).not.toMatch(/powershell|cmd\.exe|wscript/i)
    expect(setup.command).not.toContain(title)
    expect(setup.launcherDirectory).toBe(files.directory)
    expect(setup.launcherPath).toBe(files.executable)
    expect(setup.sourcePath).toBe(files.source)
    expect(setup.hashPath).toBe(files.hash)
    expect(setup.sourceHash).toBe(launcherSourceHash())
    expect(await readFile(files.source, 'utf8')).toBe(LAUNCHER_SOURCE)
    await expect(stat(files.hash)).rejects.toThrow()
    await expect(stat(join(local, 'DshNotifications', 'Notifications', 'v1', 'activate.ps1'))).rejects.toThrow()

    const shows = showCalls(calls)
    expect(shows).toHaveLength(1)
    const parsed = parseShow(shows[0]!)
    expect(parsed.payload.aumid).toBe(NOTIFICATION_APP_ID)
    expect(parsed.payload.group).toBe(NOTIFICATION_GROUP)
    expect(parsed.payload.tag).toMatch(/^[0-9a-f]{32}$/)
    expect(parsed.payload.xml.startsWith('<toast activationType="protocol"')).toBe(true)
    expect(parsed.payload.xml).toContain('<audio silent="true"/>')
    expect(parsed.payload.xml).not.toContain('scenario=')
    expect(parsed.payload.xml).toContain('&lt;完成&gt; &amp; &quot;quoted&quot;')
    expect(parsed.payload.xml).toContain('正文 &lt;b&gt; &amp; more')
    expect(shows[0]!.stdin).toContain('&lt;完成&gt; &amp; &quot;quoted&quot;')
    expect(shows[0]!.stdin).not.toContain(title)
    expect(shows[0]!.script).not.toContain('quoted')
    expect(shows[0]!.script).toBe(SHOW_SCRIPT)

    await expect(carrier.show(show('owner-1:notification-2'))).resolves.toBe(true)
    expect(setupCalls(calls)).toHaveLength(1)
  })

  it('consumes a ticket once, removes its own tag before restoring, and emits the logical id', async () => {
    const local = await localDir()
    const order: string[] = []
    const { calls, execPowerShell } = createExec(call => {
      if (call.script === REMOVE_SCRIPT) {
        const payload = JSON.parse(call.stdin) as { tags: string[] }
        order.push('remove:' + payload.tags.join(','))
      }
      return undefined
    })
    const activateDesktop = vi.fn(async () => { order.push('desktop'); return true })
    const onActivate = vi.fn((id: string) => { order.push('callback:' + id) })
    const carrier = createCarrier(execPowerShell, local, {}, { activateDesktop, onActivate })
    await expect(carrier.show(show('owner-1:notification-1'))).resolves.toBe(true)
    const parsed = parseShow(showCalls(calls)[0]!)

    const response = await postActivation(parsed.port, parsed.ticket)
    expect(response.status).toBe(202)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    await vi.waitFor(() => expect(onActivate).toHaveBeenCalledExactlyOnceWith('owner-1:notification-1'))
    expect(activateDesktop).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe('remove:' + parsed.payload.tag)
    expect(order).toContain('desktop')
    expect(order).toContain('callback:owner-1:notification-1')
    expect(calls.filter(call => call.script === SHOW_SCRIPT)).toHaveLength(1)

    expect((await postActivation(parsed.port, parsed.ticket)).status).toBe(404)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(activateDesktop).toHaveBeenCalledTimes(1)
  })

  it('keeps the callback and desktop restore independent when one of them rejects', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec()
    const onActivate = vi.fn()
    const failingDesktop = createCarrier(execPowerShell, local, {}, { activateDesktop: async () => { throw new Error('restore failed') }, onActivate })
    await expect(failingDesktop.show(show('owner-1:notification-1'))).resolves.toBe(true)
    const first = parseShow(showCalls(calls)[0]!)
    expect((await postActivation(first.port, first.ticket)).status).toBe(202)
    await vi.waitFor(() => expect(onActivate).toHaveBeenCalledExactlyOnceWith('owner-1:notification-1'))

    const activateDesktop = vi.fn(async () => true)
    const failingCallback = createCarrier(execPowerShell, local, {}, { activateDesktop, onActivate: () => { throw new Error('stream failed') } })
    await expect(failingCallback.show(show('owner-1:notification-2'))).resolves.toBe(true)
    const second = parseShow(showCalls(calls)[1]!)
    expect((await postActivation(second.port, second.ticket)).status).toBe(202)
    await vi.waitFor(() => expect(activateDesktop).toHaveBeenCalledTimes(1))
  })

  it('rejects malformed, unknown, expired, and mismatched requests without an action', async () => {
    const local = await localDir()
    let now = 0
    const { calls, execPowerShell } = createExec()
    const activateDesktop = vi.fn(async () => true)
    const onActivate = vi.fn()
    const carrier = createCarrier(execPowerShell, local, { now: () => now }, { activateDesktop, onActivate })
    await expect(carrier.show(show('owner-1:notification-1'))).resolves.toBe(true)
    const parsed = parseShow(showCalls(calls)[0]!)

    expect((await fetch(activationUrl(parsed.port, parsed.ticket), { method: 'GET' })).status).toBe(405)
    expect((await fetch(activationUrl(parsed.port, parsed.ticket), { method: 'OPTIONS' })).status).toBe(405)
    expect((await fetch('http://127.0.0.1:' + parsed.port + NOTIFICATION_ACTIVATION_PATH + 'f'.repeat(64), { method: 'POST' })).status).toBe(404)
    expect((await fetch('http://127.0.0.1:' + parsed.port + NOTIFICATION_ACTIVATION_PATH + parsed.ticket.slice(1), { method: 'POST' })).status).toBe(404)
    expect((await fetch(activationUrl(parsed.port, parsed.ticket) + '?other', { method: 'POST' })).status).toBe(404)

    now = 24 * 60 * 60 * 1000
    expect((await postActivation(parsed.port, parsed.ticket)).status).toBe(404)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(onActivate).not.toHaveBeenCalled()
    expect(activateDesktop).not.toHaveBeenCalled()
  })

  it('never overwrites an unknown protocol owner and stops retrying it', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec(call => call.script === SETUP_SCRIPT ? { code: 2 } : undefined)
    const warnings: string[] = []
    const carrier = createCarrier(execPowerShell, local, { onWarning: message => warnings.push(message) })
    await expect(carrier.show(show())).resolves.toBe(false)
    await expect(carrier.show(show('owner-1:notification-2'))).resolves.toBe(false)
    expect(setupCalls(calls)).toHaveLength(1)
    expect(showCalls(calls)).toHaveLength(0)
    expect(warnings).toContain('protocol-owner-refused')
  })

  it('removes only the requested native tag and leaves another live ticket usable', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec()
    const onActivate = vi.fn()
    const carrier = createCarrier(execPowerShell, local, {}, { onActivate })
    await expect(carrier.show(show('owner-1:a'))).resolves.toBe(true)
    await expect(carrier.show(show('owner-1:b'))).resolves.toBe(true)
    const [first, second] = showCalls(calls).map(parseShow)
    const removals = removeCalls(calls)
    const before = removals.length

    await carrier.close('owner-1:a')
    expect(removeCalls(calls)).toHaveLength(before + 1)
    const removed = JSON.parse(removeCalls(calls).at(-1)!.stdin) as { tags: string[] }
    expect(removed.tags).toEqual([first!.payload.tag])

    await carrier.close('owner-1:missing')
    expect(removeCalls(calls)).toHaveLength(before + 1)
    expect((await postActivation(first!.port, first!.ticket)).status).toBe(404)
    expect((await postActivation(second!.port, second!.ticket)).status).toBe(202)
    await vi.waitFor(() => expect(onActivate).toHaveBeenCalledExactlyOnceWith('owner-1:b'))
  })

  it('replaces a card with the same logical id and invalidates its previous ticket', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec()
    const onActivate = vi.fn()
    const carrier = createCarrier(execPowerShell, local, {}, { onActivate })
    await expect(carrier.show(show('owner-1:same'))).resolves.toBe(true)
    const first = parseShow(showCalls(calls)[0]!)
    await expect(carrier.show(show('owner-1:same'))).resolves.toBe(true)
    const second = parseShow(showCalls(calls)[1]!)

    const replacement = removeCalls(calls).map(call => JSON.parse(call.stdin) as { tags: string[] })
    expect(replacement).toContainEqual({ aumid: NOTIFICATION_APP_ID, group: NOTIFICATION_GROUP, tags: [first.payload.tag] })
    expect((await postActivation(first.port, first.ticket)).status).toBe(404)
    expect((await postActivation(second.port, second.ticket)).status).toBe(202)
    await vi.waitFor(() => expect(onActivate).toHaveBeenCalledExactlyOnceWith('owner-1:same'))
  })

  it('prunes expired tickets and their native cards on the next show', async () => {
    const local = await localDir()
    let now = 0
    const { calls, execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local, { now: () => now })
    await expect(carrier.show(show('owner-1:old'))).resolves.toBe(true)
    const old = parseShow(showCalls(calls)[0]!)
    now = 24 * 60 * 60 * 1000
    await expect(carrier.show(show('owner-1:new'))).resolves.toBe(true)
    const removals = removeCalls(calls).map(call => JSON.parse(call.stdin) as { tags: string[] })
    expect(removals.some(payload => payload.tags.includes(old.payload.tag))).toBe(true)
  })

  it('removes a card whose ticket expired without another show', async () => {
    const local = await localDir()
    let now = 0
    const { calls, execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local, { now: () => now })
    await expect(carrier.show(show('owner-1:old'))).resolves.toBe(true)
    const old = parseShow(showCalls(calls)[0]!)
    now = 24 * 60 * 60 * 1000
    await carrier.dispose()
    const removed = removeCalls(calls).map(call => JSON.parse(call.stdin) as { tags: string[] }).flatMap(payload => payload.tags)
    expect(removed).toContain(old.payload.tag)
  })

  it('reports a failed native show without keeping a ticket', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec(call => call.script === SHOW_SCRIPT ? { code: 1 } : undefined)
    const onActivate = vi.fn()
    const carrier = createCarrier(execPowerShell, local, {}, { onActivate })
    await expect(carrier.show(show())).resolves.toBe(false)
    const parsed = parseShow(showCalls(calls)[0]!)
    expect((await postActivation(parsed.port, parsed.ticket)).status).toBe(404)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('disposes its own cards and listener but keeps the shared per-user registration', async () => {
    const local = await localDir()
    const { calls, execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local)
    await expect(carrier.show(show('owner-1:a'))).resolves.toBe(true)
    await expect(carrier.show(show('owner-1:b'))).resolves.toBe(true)
    const tags = showCalls(calls).map(call => parseShow(call).payload.tag)
    const port = parseShow(showCalls(calls)[0]!).port

    await carrier.dispose()
    const removed = removeCalls(calls).map(call => JSON.parse(call.stdin) as { tags: string[] }).flatMap(payload => payload.tags)
    expect(removed).toEqual(expect.arrayContaining(tags))
    await expect(readFile(windowsLauncherFiles(local).source, 'utf8')).resolves.toBe(LAUNCHER_SOURCE)
    await expect(fetch('http://127.0.0.1:' + port + NOTIFICATION_ACTIVATION_PATH + '0'.repeat(64), { method: 'POST' })).rejects.toThrow()
    await expect(carrier.show(show('owner-1:c'))).resolves.toBe(false)
    await expect(carrier.dispose()).resolves.toBeUndefined()
  })

  it('supports two independent Host instances on the same per-user scheme', async () => {
    const local = await localDir()
    const firstExec = createExec()
    const secondExec = createExec()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()
    const first = createCarrier(firstExec.execPowerShell, local, {}, { onActivate: firstCallback })
    const second = createCarrier(secondExec.execPowerShell, local, {}, { onActivate: secondCallback })
    await expect(first.show(show('owner-1:first'))).resolves.toBe(true)
    await expect(second.show(show('owner-2:second'))).resolves.toBe(true)
    const firstShow = parseShow(showCalls(firstExec.calls)[0]!)
    const secondShow = parseShow(showCalls(secondExec.calls)[0]!)
    expect(firstShow.port).not.toBe(secondShow.port)
    expect(setupCalls(firstExec.calls)).toHaveLength(1)
    expect(setupCalls(secondExec.calls)).toHaveLength(1)

    await first.dispose()
    expect((await postActivation(secondShow.port, secondShow.ticket)).status).toBe(202)
    await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledExactlyOnceWith('owner-2:second'))
    expect(firstCallback).not.toHaveBeenCalled()
  })

  it('refuses an existing launcher target that is not a regular file', async () => {
    const local = await localDir()
    const files = windowsLauncherFiles(local)
    await mkdir(files.directory, { recursive: true })
    await mkdir(files.executable)
    const { calls, execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local)
    await expect(carrier.show(show())).resolves.toBe(false)
    expect(calls).toHaveLength(0)
  })

  it.skipIf(process.platform !== 'win32')('refuses a reparse point in the activation directory', async () => {
    const root = await rootDir()
    const local = join(root, 'Local')
    await mkdir(local)
    const outside = join(root, 'outside')
    await mkdir(outside)
    try {
      await symlink(outside, join(local, 'DshNotifications'), 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    const { calls, execPowerShell } = createExec()
    const carrier = createCarrier(execPowerShell, local)
    await expect(carrier.show(show())).resolves.toBe(false)
    expect(calls).toHaveLength(0)
    await expect(stat(join(outside, 'Notifications'))).rejects.toThrow()
  })
})

describe('fixed Windows scripts', () => {
  it('never routes the new protocol registration through a script host', () => {
    expect(SETUP_SCRIPT).toContain('-OutputType WindowsApplication')
    expect(SETUP_SCRIPT).not.toContain('activate.ps1')
    expect(SETUP_SCRIPT).not.toContain('powershell.exe')
  })

  it('uses WinRT without a reminder or a renderer navigation dependency', () => {
    expect(SHOW_SCRIPT).toContain('CreateToastNotifier')
    expect(SHOW_SCRIPT).toContain('ToastNotification')
    expect(SHOW_SCRIPT).toContain('[Console]::OpenStandardInput()')
    expect(SHOW_SCRIPT).not.toContain('scenario=')
    expect(REMOVE_SCRIPT).toContain('History.Remove')
    expect(SETUP_SCRIPT).toContain('exit 2')
    expect(SETUP_SCRIPT).toContain('HKCU:')
  })
})

it.each([SETUP_SCRIPT,SHOW_SCRIPT])('cancels a popup while its native operation is pending',async blockedScript=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const calls:ExecCall[]=[];let blocked=false
 const execPowerShell=vi.fn(async(script:string,stdin:string):Promise<WindowsPowerShellResult>=>{calls.push({script,stdin});if(script===blockedScript&&!blocked){blocked=true;entered.resolve();await release.promise}return{code:0,stdout:'',stderr:''}})
 const carrier=createCarrier(execPowerShell,await localDir());const sending=carrier.show(show('pending-card'))
 try{await entered.promise;await carrier.close('pending-card');release.resolve();expect(await sending).toBe(false);if(blockedScript===SETUP_SCRIPT)expect(showCalls(calls)).toHaveLength(0)}finally{release.resolve();await sending}
})
it('does not block restoration or the activation frame on slow native history removal',async()=>{
 const release=Promise.withResolvers<void>(),calls:ExecCall[]=[];const activateDesktop=vi.fn(async()=>true),onActivate=vi.fn()
 const execPowerShell=vi.fn(async(script:string,stdin:string):Promise<WindowsPowerShellResult>=>{calls.push({script,stdin});if(script===REMOVE_SCRIPT)await release.promise;return{code:0,stdout:'',stderr:''}})
 const carrier=createCarrier(execPowerShell,await localDir(),{},{activateDesktop,onActivate})
 try{await carrier.show(show());const current=parseShow(showCalls(calls)[0]!);expect((await postActivation(current.port,current.ticket)).status).toBe(202);await vi.waitFor(()=>expect(activateDesktop).toHaveBeenCalledOnce());expect(onActivate).toHaveBeenCalledWith('owner-1:notification-1')}finally{release.resolve()}
})
