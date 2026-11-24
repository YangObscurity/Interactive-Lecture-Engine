/**
 * Unit tests for S6Z-3 (Reading Appearance Tints + site-level theme.json) and
 * S6Z-4 (External MCP Server CRUD + secret safety + validation).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addMcpServer,
  checkThemeContrast,
  readThemeView,
  readToolsView,
  removeMcpServer,
  saveThemeConfig,
  validateMcpServer,
  writeToolSwitches,
} from '../../docs/.vitepress/plugins/dashboardDevExtras.mts'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import type { ContentPaths } from '../../docs/.vitepress/content/paths.mts'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makeMockPaths(): ContentPaths & { tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's6z34-test-'))
  tmpDirs.push(tmpDir)

  const contentDir = path.join(tmpDir, 'content')
  fs.mkdirSync(contentDir, { recursive: true })

  const repoRoot = tmpDir
  const aiToolsFile = path.join(contentDir, 'ai-tools.json')
  const aiToolsExample = path.join(tmpDir, 'ai-tools.example.json')
  const themeFile = path.join(tmpDir, 'site', 'theme.json')
  fs.mkdirSync(path.dirname(themeFile), { recursive: true })

  // Write base ai-tools.json
  fs.writeFileSync(
    aiToolsFile,
    JSON.stringify(
      {
        engineTools: {
          search_concepts: { enabled: true },
          get_concept: { enabled: true },
        },
        mcpServers: [
          {
            id: 'existing-srv',
            name: 'Existing Server',
            url: 'https://example.com/mcp',
            headerEnv: { Authorization: 'EXISTING_TOKEN' },
            enabled: true,
            tools: { ping: { enabled: true } },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )

  // Write .env
  fs.writeFileSync(path.join(repoRoot, '.env'), 'EXISTING_TOKEN=test_secret_12345\n', 'utf8')

  return {
    contentDir,
    repoRoot,
    aiToolsFile,
    aiToolsExample,
    themeFile,
    tmpDir,
  } as unknown as ContentPaths & { tmpDir: string }
}

describe('S6Z-3: Appearance Tints & theme.json', () => {
  it('checkThemeContrast verifies WCAG contrast against active skin palette', () => {
    // Valid light paper
    const paperRes = checkThemeContrast('reader', 'paper')
    expect(paperRes).not.toBeNull()
    expect(paperRes?.ok).toBe(true)
    expect(paperRes?.rows).toHaveLength(4)
    expect(paperRes?.rows.every((c) => c.pass)).toBe(true)

    // Valid dark
    const darkRes = checkThemeContrast('reader', 'dark')
    expect(darkRes).not.toBeNull()
    expect(darkRes?.ok).toBe(true)
    expect(darkRes?.rows).toHaveLength(4)
    expect(darkRes?.rows.every((c) => c.pass)).toBe(true)

    // Built-in green swatch passes contrast for reader skin
    const greenRes = checkThemeContrast('reader', 'green')
    expect(greenRes).not.toBeNull()
    expect(greenRes?.ok).toBe(true)

    // Invalid hex
    const invalidHexRes = checkThemeContrast('reader', 'custom', 'invalid')
    expect(invalidHexRes).toBeNull()

    // Low contrast custom hex (e.g. #888888 with low text contrast)
    const lowContrastRes = checkThemeContrast('reader', 'custom', '#888888')
    expect(lowContrastRes).not.toBeNull()
    expect(lowContrastRes?.ok).toBe(false)
    expect(lowContrastRes?.rows.some((c) => !c.pass)).toBe(true)
  })

  it('saveThemeConfig persists valid DTCG theme.json without clobbering light/dark and readThemeView retrieves it', () => {
    const paths = makeMockPaths()

    const saveSepia = saveThemeConfig(paths, { skin: 'reader', base: 'sepia' })
    expect(saveSepia.ok).toBe(true)
    const writtenSepia = JSON.parse(fs.readFileSync(paths.themeFile, 'utf8'))
    expect(writtenSepia.modes).toBeUndefined()

    const saveRes = saveThemeConfig(paths, {
      skin: 'datasheet',
      base: 'custom',
      custom: '#EAF2E3',
    })
    expect(saveRes.ok).toBe(true)
    if (!saveRes.ok) return

    expect(fs.existsSync(paths.themeFile)).toBe(true)
    const written = JSON.parse(fs.readFileSync(paths.themeFile, 'utf8'))
    expect(written.$extensions['org.lecture-engine']).toMatchObject({
      skin: 'datasheet',
      base: 'custom',
      custom: '#EAF2E3',
    })
    expect(written.modes).toBeDefined()
    expect(written.modes.custom).toBeDefined()
    expect(written.modes.light).toBeUndefined()

    const view = readThemeView(paths)
    expect(view.exists).toBe(true)
    expect(view.skin).toBe('datasheet')
    expect(view.base).toBe('custom')
    expect(view.custom).toBe('#EAF2E3')
  })

  it('saveThemeConfig rejects contrast failures and invalid inputs', () => {
    const paths = makeMockPaths()

    // Invalid custom hex
    const res1 = saveThemeConfig(paths, { skin: 'reader', base: 'custom', custom: 'bad' })
    expect(res1.ok).toBe(false)
    expect((res1 as { error: string }).error).toBe('invalid_hex')

    // Contrast failure
    const res2 = saveThemeConfig(paths, { skin: 'reader', base: 'custom', custom: '#888888' })
    expect(res2.ok).toBe(false)
    expect((res2 as { error: string }).error).toBe('contrast_check_failed')
  })
})

describe('S6Z-4: External MCP Server CRUD & Validation', () => {
  it('validateMcpServer enforces strict field constraints', () => {
    // Valid input
    const valid = validateMcpServer({
      id: 'zotero-lib',
      name: 'Zotero Library',
      url: 'https://api.zotero.org/mcp',
      hdr: 'X-API-Key',
      env: 'ZOTERO_API_KEY',
    })
    expect(valid.ok).toBe(true)

    // Name required
    const noName = validateMcpServer({ name: '  ', url: 'https://example.com', env: 'FOO' })
    expect(noName.ok).toBe(false)
    expect((noName as { error: string }).error).toBe('name_required')

    // Reject non-https URL (reject http:// and malformed hostless https://///)
    const httpUrl = validateMcpServer({ name: 'Test', url: 'http://insecure.org/mcp', env: 'FOO' })
    expect(httpUrl.ok).toBe(false)
    expect((httpUrl as { error: string }).error).toBe('url_invalid')
    const malformedUrl = validateMcpServer({ name: 'Test', url: 'https://///', env: 'FOO' })
    expect(malformedUrl.ok).toBe(false)
    expect((malformedUrl as { error: string }).error).toBe('url_invalid')

    // Reject invalid header name
    const badHdr = validateMcpServer({ name: 'Test', url: 'https://example.com', hdr: 'Bad Header!', env: 'FOO' })
    expect(badHdr.ok).toBe(false)
    expect((badHdr as { error: string }).error).toBe('hdr_invalid')

    // Reject invalid env var name
    const badEnv = validateMcpServer({ name: 'Test', url: 'https://example.com', env: 'lower_env' })
    expect(badEnv.ok).toBe(false)
    expect((badEnv as { error: string }).error).toBe('env_invalid')

    // Reject duplicate ID
    const dup = validateMcpServer({ id: 'srv-1', name: 'Server 1', url: 'https://example.com', env: 'FOO' }, ['srv-1'])
    expect(dup.ok).toBe(false)
    expect((dup as { error: string }).error).toBe('id_exists')
  })

  it('validateMcpServer protects against raw secret / token leaks', () => {
    const leak1 = validateMcpServer({
      name: 'Test',
      url: 'https://example.com',
      env: 'FOO',
      hdr: 'sk-' + 'abcdef1234567890abcdef',
    })
    expect(leak1.ok).toBe(false)
    expect((leak1 as { error: string }).error).toBe('secret_leak_rejected')

    const leak2 = validateMcpServer({
      name: 'Test',
      url: 'https://example.com',
      env: 'bearer my_actual_token_value',
    })
    expect(leak2.ok).toBe(false)
    expect((leak2 as { error: string }).error).toBe('secret_leak_rejected')
  })

  it('addMcpServer adds server, checks env var presence, and never writes secrets', () => {
    const paths = makeMockPaths()

    const addRes = addMcpServer(paths, {
      name: 'Zotero',
      url: 'https://zotero.org/mcp',
      hdr: 'Authorization',
      env: 'EXISTING_TOKEN', // This is set in .env
    })
    expect(addRes.ok).toBe(true)
    if (!addRes.ok) return

    expect(addRes.server.id).toBe('zotero')
    expect(addRes.server.headers[0]?.set).toBe(true)

    // Verify written file does NOT contain the secret value
    const written = fs.readFileSync(paths.aiToolsFile, 'utf8')
    expect(written).not.toContain('test_secret_12345')
    expect(written).toContain('EXISTING_TOKEN')

    const view = readToolsView(paths)
    const added = view.servers.find((s) => s.id === 'zotero')
    expect(added).toBeDefined()
    expect(added?.name).toBe('Zotero')
    expect(added?.headers[0]?.env).toBe('EXISTING_TOKEN')
    expect(added?.headers[0]?.set).toBe(true)
  })

  it('removeMcpServer removes server entry cleanly from ai-tools.json', () => {
    const paths = makeMockPaths()

    const remRes = removeMcpServer(paths, 'existing-srv')
    expect(remRes.ok).toBe(true)

    const view = readToolsView(paths)
    expect(view.servers.find((s) => s.id === 'existing-srv')).toBeUndefined()

    // Second removal returns unknown_server
    const remAgain = removeMcpServer(paths, 'existing-srv')
    expect(remAgain.ok).toBe(false)
  })

  it('writeToolSwitches supports array of servers for draft synchronization', () => {
    const paths = makeMockPaths()

    const res = writeToolSwitches(paths, {
      engine: { search_concepts: false },
      servers: [
        {
          id: 'new-draft-srv',
          name: 'New Draft',
          url: 'https://draft.example.com/mcp',
          headers: [{ name: 'Authorization', env: 'DRAFT_TOKEN' }],
          enabled: false,
          tools: {},
        },
      ],
    })
    expect(res.ok).toBe(true)

    const view = readToolsView(paths)
    expect(view.engine.search_concepts).toBe(false)
    expect(view.servers).toHaveLength(1)
    expect(view.servers[0]?.id).toBe('new-draft-srv')
    expect(view.servers[0]?.name).toBe('New Draft')
  })
})

describe('S6Z-3 + S6Z-4: demo_read_only guards in dev server plugin', () => {
  type Invoke = (o: { method: string; url: string; token?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> | null }>

  function makeInvoker(opts: Parameters<typeof createDashboardDevHandler>[0]): Invoke {
    const handler = createDashboardDevHandler({ token: 'test-token', ...opts })
    return (o) =>
      new Promise((resolve) => {
        const req = new EventEmitter() as IncomingMessage
        req.method = o.method
        req.url = o.url
        req.headers = { host: '127.0.0.1', ...(o.token !== '' ? { 'x-lecture-dev-token': o.token ?? 'test-token' } : {}) }
        req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
        let status = 200
        let raw = ''
        const res = {
          setHeader() {
            return this
          },
          writeHead(code: number) {
            status = code
            return this
          },
          end(chunk?: string) {
            if (chunk) raw += String(chunk)
            let json: Record<string, unknown> | null = null
            try {
              json = JSON.parse(raw) as Record<string, unknown>
            } catch {
              json = null
            }
            resolve({ status, json })
          },
        } as unknown as ServerResponse
        void handler(req, res, () => resolve({ status: 0, json: null }))
        process.nextTick(() => {
          if (o.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(o.body), 'utf8'))
          req.emit('end')
        })
      })
  }

  it('refuses POST /theme with 409 demo_read_only when demo: true', async () => {
    const invoke = makeInvoker({ demo: true })
    const r = await invoke({ method: 'POST', url: '/__lecture/api/theme', body: { skin: 'reader', base: 'paper' } })
    expect(r.status).toBe(409)
    expect(r.json?.error).toBe('demo_read_only')
  })

  it('refuses POST /tools/servers with 409 demo_read_only when demo: true', async () => {
    const invoke = makeInvoker({ demo: true })
    const r = await invoke({
      method: 'POST',
      url: '/__lecture/api/tools/servers',
      body: { name: 'Zotero', url: 'https://zotero.org/mcp', env: 'ZOTERO_TOKEN' },
    })
    expect(r.status).toBe(409)
    expect(r.json?.error).toBe('demo_read_only')
  })

  it('refuses DELETE /tools/servers/:id with 409 demo_read_only when demo: true', async () => {
    const invoke = makeInvoker({ demo: true })
    const r = await invoke({
      method: 'DELETE',
      url: '/__lecture/api/tools/servers/some-server',
    })
    expect(r.status).toBe(409)
    expect(r.json?.error).toBe('demo_read_only')
  })
})
