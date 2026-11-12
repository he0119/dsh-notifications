/** Decision notes declare their shape; this test keeps the declarations honest. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const NOTES = join(ROOT, '.agents/notes')

/** 生命周期目录 ⇄ `Status:` 行。 */
const STATUS: Record<string, string> = { implemented: 'implemented', rejected: 'rejected' }
/** 封闭的类别集合，见 .agents/notes/AGENTS.md。 */
const CLASSES = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing']
/** implemented 笔记必备的章节，以及提案期才用、落地后不许留下的章节。 */
const REQUIRED = ['## Decision', '## Alternatives considered', '## Consequences']
const FORBIDDEN = ['## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria']

/** @param directory - 起点目录。 @returns 该目录下所有 `.md` 文件的绝对路径。 */
async function markdownFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'AGENTS.md') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)))
    else if (entry.name.endsWith('.md')) found.push(path)
  }
  return found
}

/** @param body - 笔记正文。 @returns 所有二级标题，按出现顺序。 */
function sections(body: string): string[] {
  return body.split('\n').filter(line => line.startsWith('## ')).map(line => line.trim())
}

/** @param body - 笔记正文。 @returns Markdown 里指向文件的相对链接目标。 */
function relativeLinks(body: string): string[] {
  return [...body.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map(match => match[1]!)
    .filter(target => !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(target))
}

it('每篇决策笔记的路径、头部与章节都符合声明', async () => {
  const files = await markdownFiles(NOTES)
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const path = file.slice(NOTES.length + 1).replaceAll('\\', '/')
    const segments = path.split('/')
    expect(segments, path).toHaveLength(3)
    const [lifecycle, category, name] = segments as [string, string, string]
    expect(Object.keys(STATUS), path).toContain(lifecycle)
    expect(CLASSES, path).toContain(category)
    expect(name, path).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u)

    const body = await readFile(file, 'utf8')
    const lines = body.split('\n')
    expect(lines[0], path).toMatch(/^# Agent Note: \S/u)
    expect(lines[1], path).toBe('')
    const status = STATUS[lifecycle]!
    expect(lines[2], path).toMatch(
      status === 'rejected' ? /^Status: rejected — \S/u : /^Status: implemented$/u,
    )
    expect(lines[3], path).toBe('')

    const headings = sections(body)
    expect(headings[0], path).toBe('## Problem')
    expect(headings, path).toContain('## Alternatives considered')
    if (lifecycle === 'implemented') {
      for (const section of REQUIRED) expect(headings, path).toContain(section)
      for (const section of FORBIDDEN) expect(headings, path).not.toContain(section)
    } else {
      expect(headings, path).toContain('## Proposal')
    }

    for (const target of relativeLinks(body)) {
      const destination = resolve(dirname(file), target.split('#')[0]!)
      await expect(stat(destination), `${path} → ${target}`).resolves.toBeTruthy()
    }
  }
})
