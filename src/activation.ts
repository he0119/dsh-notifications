/** Fixed desktop activation, isolated from an Electron-as-Node Host environment. */
import open from 'open'
import { Worker } from 'node:worker_threads'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/** OS URL-opening boundary; the Remote never accepts an arbitrary URI. */
export type DesktopActivationOpener = (uri: string, options: { wait: false }) => Promise<unknown>

/** Copy launch variables without turning the desktop protocol handler into a Node process. */
export function desktopActivationEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[0].toUpperCase() !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined))
}

const activationWorker =   "const {parentPort,workerData}=require('node:worker_threads');" +
  "(async()=>{try{const {default:open}=await import(workerData.openModule);await open('dsh://open',{wait:false});parentPort.postMessage(true)}catch{parentPort.postMessage(false)}finally{parentPort.close()}})()"

function requestFromIsolatedEnvironment(): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const worker = new Worker(activationWorker, { eval:true, execArgv:[], env:desktopActivationEnvironment(process.env), workerData:{openModule:import.meta.resolve('open')} })
    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(accepted)
      void worker.terminate().catch(() => {})
    }
    const deadline = setTimeout(() => finish(false), 5_000)
    worker.once('message', value => finish(value === true))
    worker.once('error', () => finish(false))
    worker.once('exit', () => finish(false))
  })
}

export type DesktopActivationSpawn = (command: string, args: readonly string[], options: { windowsHide: true; shell: false; stdio: 'ignore'; env: Record<string, string> }) => Pick<ChildProcess, 'once' | 'kill'>

/** Host restoration must set CreateNoWindow before Windows allocates a console. */
export function activateWindowsDesktop(spawnProcess: DesktopActivationSpawn = (command, args, options) => spawn(command, [...args], options), environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    let child: Pick<ChildProcess, 'once' | 'kill'>
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = (accepted: boolean): void => { if (settled) return; settled = true; clearTimeout(deadline); resolve(accepted) }
    try {
      const systemRoot = Object.entries(environment).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1] ?? 'C:/Windows'
      const script = "$ErrorActionPreference='Stop'; Start-Process -FilePath 'dsh://open' | Out-Null"
      child = spawnProcess(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: 'ignore', env: desktopActivationEnvironment(environment) })
      deadline = setTimeout(() => { finish(false); try { child.kill() } catch {} }, 5_000)
      deadline.unref()
      child.once('error', () => finish(false))
      child.once('exit', code => finish(code === 0))
    } catch { finish(false) }
  })
}

/** Submit a fixed protocol request; acceptance alone is not proof that the window restored. */
export async function activateDesktopApp(opener?: DesktopActivationOpener): Promise<boolean> {
  try {
    if (opener !== undefined) { await opener('dsh://open', {wait:false}); return true }
    if (process.platform === 'win32') return await activateWindowsDesktop()
    if (Object.keys(process.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE')) return await requestFromIsolatedEnvironment()
    await open('dsh://open', {wait:false})
    return true
  } catch (_refused) { return false }
}
