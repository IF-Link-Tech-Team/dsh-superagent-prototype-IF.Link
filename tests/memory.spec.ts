/** The team memory files the main Session reads, and the ticket copy the executor makes of them. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readResource, resourceGrammar, type ResourceHost } from '../src/app/resources.ts'
import { copyMemory } from '../src/executor/dsh.ts'

const host = (memoryDir: string) => ({ memoryDir, masterId: 'orchestrator', settings: {} } as unknown as ResourceHost)
const project = () => mkdtempSync(join(tmpdir(), 'memory-'))

describe('memory resources', () => {
  it('lists only Markdown memory files, with the size and update time of each', async () => {
    const dir = project()
    writeFileSync(join(dir, 'TEAM.md'), '# 团队\n- 事实')
    writeFileSync(join(dir, 'PROJECTS.md'), '# 项目')
    writeFileSync(join(dir, 'notes.txt'), 'not a memory file')
    const read = await readResource(host(dir), 'memory', 0, undefined) as { text: string }
    const listed = JSON.parse(read.text) as { files: { file: string; chars: number; updated: string }[]; read: string }
    expect(listed.files.map(file => file.file)).toEqual(['PROJECTS.md', 'TEAM.md'])
    expect(listed.files.find(file => file.file === 'TEAM.md')?.chars).toBe(9)
    expect(listed.files.every(file => file.updated.endsWith('Z'))).toBe(true)
    expect(listed.read).toBe('memory/<file>')
  })

  it('serves one memory file whole, and paged when a caller asks for a slice', async () => {
    const dir = project()
    writeFileSync(join(dir, 'PROJECTS.md'), '# 项目：第二课堂\n- 当前阶段：试点')
    expect(await readResource(host(dir), 'memory/PROJECTS.md', 0, undefined)).toMatchObject({ text: '# 项目：第二课堂\n- 当前阶段：试点' })
    expect(await readResource(host(dir), 'memory/PROJECTS.md', 4, 3)).toMatchObject({ offset: 4, text: '：第二' })
  })

  it('refuses a traversal or a file that is not there rather than reading something else', async () => {
    const dir = project()
    writeFileSync(join(dir, 'TEAM.md'), '# 团队')
    await expect(readResource(host(dir), 'memory/../secret.md', 0, undefined)).rejects.toThrow('Unknown memory file')
    await expect(readResource(host(dir), 'memory/TEAM.md/x', 0, undefined)).rejects.toThrow('Unknown memory file')
    await expect(readResource(host(dir), 'memory/MISSING.md', 0, undefined)).rejects.toThrow('No memory file MISSING.md')
  })

  it('reports an empty list when the deployment keeps no memory directory, rather than failing the read', async () => {
    const read = await readResource(host(join(project(), 'absent')), 'memory', 0, undefined) as { text: string }
    expect(JSON.parse(read.text).files).toEqual([])
  })

  it('offers memory and the journal to both roles, since a ticket may need more than its own snapshot', () => {
    for (const grammar of [resourceGrammar(false), resourceGrammar(true)]) {
      expect(grammar).toContain('memory:')
      expect(grammar).toContain('memory/<file>:')
      expect(grammar).toContain('journal:')
      expect(grammar).toContain('journal/<file>:')
    }
  })

  it('lists journal entries newest first with their date range as the title', async () => {
    const dir = project()
    mkdirSync(join(dir, 'journal'), { recursive: true })
    writeFileSync(join(dir, 'journal', '2026-10-05_10-11.md'), '# 2026-10-05 ~ 10-11\n\n## 项目｜第二课堂\n- 10-06 一件事\n')
    writeFileSync(join(dir, 'journal', '2026-10-12_10-18.md'), '# 2026-10-12 ~ 10-18\n- 10-13 另一件\n')
    writeFileSync(join(dir, 'journal', 'notes.txt'), 'not an entry')
    const read = await readResource(host(dir), 'journal', 0, undefined) as { text: string }
    const listed = JSON.parse(read.text) as { entries: { file: string; title: string }[] }
    expect(listed.entries.map(entry => entry.file)).toEqual(['2026-10-12_10-18.md', '2026-10-05_10-11.md'])
    expect(listed.entries[0]?.title).toBe('2026-10-12 ~ 10-18')
    expect(await readResource(host(dir), 'journal/2026-10-05_10-11.md', 0, undefined)).toMatchObject({ text: expect.stringContaining('10-06 一件事') })
    await expect(readResource(host(dir), 'journal/notes.txt', 0, undefined)).rejects.toThrow('Unknown journal entry')
  })

  it('keeps the ticket copy to the memory files, skipping anything else in the directory', async () => {
    const from = project(), to = join(project(), 'memory')
    writeFileSync(join(from, 'TEAM.md'), '# 团队')
    writeFileSync(join(from, 'notes.txt'), 'skip')
    await copyMemory(from, to)
    expect(readdirSync(to)).toEqual(['TEAM.md'])
    expect(readFileSync(join(to, 'TEAM.md'), 'utf8')).toBe('# 团队')
  })
})
