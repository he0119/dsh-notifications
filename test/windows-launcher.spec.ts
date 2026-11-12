/** Windows GUI launcher source, PE contract, and local QA compilation. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LAUNCHER_DIRECTORY_NAME,
  LAUNCHER_EXECUTABLE_NAME,
  LAUNCHER_HASH_NAME,
  LAUNCHER_SOURCE,
  LAUNCHER_SOURCE_NAME,
  LAUNCHER_SOURCE_VERSION,
  isWindowsGuiLauncher,
  launcherSourceHash,
  windowsLauncherFiles,
  windowsLauncherSubsystem,
} from '../src/windows/launcher.ts'
import { SETUP_SCRIPT } from '../src/windows/scripts.ts'

function peImage(subsystem: number): Uint8Array {
  const bytes = new Uint8Array(0x120)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x4d
  bytes[1] = 0x5a
  const pe = 0x80
  view.setUint32(0x3c, pe, true)
  bytes[pe] = 0x50
  bytes[pe + 1] = 0x45
  bytes[pe + 2] = 0
  bytes[pe + 3] = 0
  view.setUint16(pe + 0x5c, subsystem, true)
  return bytes
}

function run(command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr })
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', () => finish(null))
    child.once('close', code => finish(code))
  })
}

const qaRoot = join(process.cwd(), 'dist', 'windows-launcher-qa')

describe('fixed Windows launcher source', () => {
  it('is a fixed C# launcher for the exact protocol URI and fixed loopback POST', () => {
    expect(LAUNCHER_SOURCE).toContain('dsh-notifications://activate/([1-9][0-9]{0,4})/([0-9a-f]{64})\\z')
    expect(LAUNCHER_SOURCE).toContain('HttpWebRequest')
    expect(LAUNCHER_SOURCE).toContain('request.Method = "POST"')
    expect(LAUNCHER_SOURCE).toContain('request.Proxy = null')
    expect(LAUNCHER_SOURCE).toContain('request.AllowAutoRedirect = false')
    expect(LAUNCHER_SOURCE).toContain('request.Timeout = 10000')
    expect(LAUNCHER_SOURCE).toContain('request.ReadWriteTimeout = 10000')
    expect(LAUNCHER_SOURCE).toContain('(int)response.StatusCode != 202')
    expect(LAUNCHER_SOURCE).toContain('"http://127.0.0.1:"')
    expect(LAUNCHER_SOURCE).toContain('"/dsh-notifications/activate/"')
    expect(LAUNCHER_SOURCE).toContain('"dsh://open"')
    expect(LAUNCHER_SOURCE).toContain('start.UseShellExecute = true')
    expect(LAUNCHER_SOURCE).toContain('start.ErrorDialog = false')
    expect(LAUNCHER_SOURCE).toContain('ELECTRON_RUN_AS_NODE')
    expect(LAUNCHER_SOURCE).toContain('return 2')
    expect(LAUNCHER_SOURCE).toContain('return 3')
    expect(LAUNCHER_SOURCE).not.toContain('System.Net.Http')
    expect(LAUNCHER_SOURCE).not.toContain('HttpClient')
    expect(LAUNCHER_SOURCE).not.toContain('System.Windows.Forms')
    expect(LAUNCHER_SOURCE).not.toContain('MessageBox')
    expect(LAUNCHER_SOURCE).not.toContain('Console.')
    expect(LAUNCHER_SOURCE).not.toContain('Start-Process')
    expect(LAUNCHER_SOURCE).not.toContain('cmd.exe')
    expect(LAUNCHER_SOURCE).not.toContain('wscript')
  })

  it('has a stable v2 path and source hash', () => {
    expect(LAUNCHER_SOURCE_VERSION).toBe('v2')
    expect(LAUNCHER_DIRECTORY_NAME).toBe('v2')
    expect(LAUNCHER_EXECUTABLE_NAME).toBe('activate.exe')
    expect(LAUNCHER_SOURCE_NAME).toBe('activate.cs')
    expect(LAUNCHER_HASH_NAME).toBe('activate.sha256')
    const local = join(process.cwd(), 'dist', 'launcher-path-fixture')
    const files = windowsLauncherFiles(local)
    expect(files.directory).toBe(join(local, 'DshNotifications', 'Notifications', 'v2'))
    expect(files.executable).toBe(join(files.directory, 'activate.exe'))
    expect(files.source).toBe(join(files.directory, 'activate.cs'))
    expect(files.hash).toBe(join(files.directory, 'activate.sha256'))
    expect(launcherSourceHash()).toMatch(/^[0-9a-f]{64}$/)
    expect(launcherSourceHash('a')).not.toBe(launcherSourceHash('b'))
  })

  it('parses the PE subsystem and identifies only Windows GUI images', () => {
    expect(windowsLauncherSubsystem(peImage(2))).toBe(2)
    expect(isWindowsGuiLauncher(peImage(2))).toBe(true)
    expect(windowsLauncherSubsystem(peImage(3))).toBe(3)
    expect(isWindowsGuiLauncher(peImage(3))).toBe(false)
    expect(windowsLauncherSubsystem(new Uint8Array(8))).toBeUndefined()
    expect(windowsLauncherSubsystem(new Uint8Array(0x120))).toBeUndefined()
  })

  it('requires the production setup to compile and verify a GUI exe before registration', () => {
    expect(SETUP_SCRIPT).toContain('ReparsePoint')
    expect(SETUP_SCRIPT).toContain('SHA256')
    expect(SETUP_SCRIPT).toContain('Add-Type')
    expect(SETUP_SCRIPT).toContain('-OutputType WindowsApplication')
    expect(SETUP_SCRIPT).toContain('-OutputAssembly')
    expect(SETUP_SCRIPT).toContain('0x5C')
    expect(SETUP_SCRIPT).toContain('File]::Replace')
    expect(SETUP_SCRIPT).toContain("[System.IO.Path]::GetFileName($launcher) -ne 'activate.exe'")
    expect(SETUP_SCRIPT).toContain('$payload.command -ne')
    expect(SETUP_SCRIPT).toContain('exit 2')
    expect(SETUP_SCRIPT).not.toContain('activate.ps1')
    expect(SETUP_SCRIPT).not.toContain('-WindowStyle Hidden')
    expect(SETUP_SCRIPT).not.toMatch(/cmd\.exe|wscript|powershell\.exe/i)
  })

  it.skipIf(process.platform !== 'win32')('compiles this source to a real Windows GUI PE and rejects invalid/denied HTTP without launching DSH', async () => {
    await rm(qaRoot, { recursive: true, force: true })
    await mkdir(qaRoot, { recursive: true })
    const sourcePath = join(qaRoot, 'activate.cs')
    const executablePath = join(qaRoot, 'activate.exe')
    const buildScript = join(qaRoot, 'build.ps1')
    await writeFile(sourcePath, LAUNCHER_SOURCE, 'utf8')
    await writeFile(buildScript, [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($args[0])) -Language CSharp -OutputType WindowsApplication -OutputAssembly $args[1] -ErrorAction Stop',
      'exit 0',
    ].join('\r\n'), 'utf8')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const compiled = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', buildScript, sourcePath, executablePath])
    expect(compiled.code, compiled.stderr).toBe(0)
    const bytes = await readFile(executablePath)
    expect(windowsLauncherSubsystem(bytes)).toBe(2)
    expect(isWindowsGuiLauncher(bytes)).toBe(true)

    expect((await run(executablePath, ['https://example.com/'])).code).toBe(2)
    expect((await run(executablePath, [])).code).toBe(2)
    const ticket = 'a'.repeat(64)
    const requests: { method?: string; url?: string }[] = []
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.writeHead(403)
      response.end()
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('loopback address unavailable')
      const uri = 'dsh-notifications://activate/' + address.port + '/' + ticket
      const denied = await run(executablePath, [uri])
      expect(denied.code).toBe(3)
      expect(requests).toEqual([{ method: 'POST', url: '/dsh-notifications/activate/' + ticket }])
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }, 120000)
})
