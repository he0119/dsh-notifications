/** Protocol handoff requests, without claiming that a native window was restored. */
import { expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activateDesktopApp, activateWindowsDesktop, desktopActivationEnvironment, type DesktopActivationSpawn } from '../src/activation.ts'

it('submits only the fixed desktop activation URI without waiting for application exit', async () => {
  const opener = vi.fn(async (_uri: string, _options: { wait: false }) => undefined)
  await expect(activateDesktopApp(opener)).resolves.toBe(true)
  expect(opener).toHaveBeenCalledExactlyOnceWith('dsh://open', { wait: false })
})

it('reports a refused protocol handoff as false without rejecting the click action', async () => {
  const opener = vi.fn(async () => { throw new Error('The protocol handler is unavailable') })
  await expect(activateDesktopApp(opener)).resolves.toBe(false)
})

it('isolates inherited Electron Node mode in the real activation worker without mutating its parent', async () => {
  const inherited = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', CYANESS_ACTIVATION_TEST: 'retained' }
  const clean = desktopActivationEnvironment(inherited)
  const result = await new Promise<{ electron: string | null; other: string | undefined }>((resolve, reject) => {
    const worker = new Worker("const {parentPort}=require('node:worker_threads');parentPort.postMessage({electron:process.env.ELECTRON_RUN_AS_NODE??null,other:process.env.CYANESS_ACTIVATION_TEST});parentPort.close()", { eval:true, env:clean })
    worker.once('error', reject)
    worker.once('message', resolve)
  })
  expect(result).toEqual({electron:null,other:'retained'})
  expect(inherited.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(inherited.electron_run_as_node).toBe('1')
  expect(clean).not.toHaveProperty('electron_run_as_node')
})

it('starts Windows restoration without a shell or visible console and preserves its parent environment',async()=>{
 const child=Object.assign(new EventEmitter(),{kill:vi.fn(()=>true)}),spawnProcess=vi.fn<DesktopActivationSpawn>(()=>child)
 const environment={SystemRoot:join(tmpdir(),'Windows fixture'),ELECTRON_RUN_AS_NODE:'1',electron_run_as_node:'1',KEEP:'yes'}
 const pending=activateWindowsDesktop(spawnProcess,environment)
 child.emit('exit',0)
 await expect(pending).resolves.toBe(true)
 const [command,args,options]=spawnProcess.mock.calls[0]!
 expect(command).toBe(join(environment.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'))
 expect(Buffer.from(args.at(-1)!,'base64').toString('utf16le')).toContain("Start-Process -FilePath 'dsh://open'")
 expect(options).toMatchObject({windowsHide:true,shell:false,stdio:'ignore',env:{KEEP:'yes'}})
 expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');expect(options.env).not.toHaveProperty('electron_run_as_node');expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
})
it('reports a refused hidden Windows launch without rejecting navigation',async()=>{
 await expect(activateWindowsDesktop(()=>{throw Error('unavailable')})).resolves.toBe(false)
 const child=Object.assign(new EventEmitter(),{kill:()=>true}),pending=activateWindowsDesktop(()=>child)
 child.emit('exit',1);await expect(pending).resolves.toBe(false)
})
