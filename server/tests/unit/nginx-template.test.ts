import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const TEMPLATE = resolve(__dirname, '../../deploy/nginx-locations.conf')

interface Location {
  head: string
  body: string
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // '#' starts a comment only outside quotes; the template has no '#' inside quoted strings.
      const i = line.indexOf('#')
      return i >= 0 ? line.slice(0, i) : line
    })
    .join('\n')
}

/** Extract every `location ... { ... }` block (nested braces such as `if {}` are kept inside the body). */
export function parseLocations(text: string): Location[] {
  const src = stripComments(text)
  const out: Location[] = []
  const re = /\blocation\s+([^{;]+?)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let depth = 1
    let i = re.lastIndex
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    out.push({ head: m[1] ?? '', body: src.slice(re.lastIndex, i - 1) })
    re.lastIndex = i
  }
  return out
}

const AUTH_OPTIONAL = new Set(['= /api/health', '/api/tool/', '= /api/mcp'])
const IDENTITY = ['Remote-User', 'Remote-Groups', 'Remote-Email', 'Remote-Name']

describe('server/deploy/nginx-locations.conf', () => {
  const text = readFileSync(TEMPLATE, 'utf8')
  const locations = parseLocations(text)
  const proxying = locations.filter((l) => /proxy_pass\s+http:\/\/lecture_(api|legacy)_backend/.test(l.body))

  it('parses a plausible set of locations', () => {
    const heads = locations.map((l) => l.head)
    for (const h of ['/api/db/', '/api/admin/', '= /api/auth/session', '/api/auth/', '/api/me/', '= /api/health', '/api/ai/', '/api/tools/', '= /api/mcp', '/api/progress/', '/api/notion/', '/api/tool/']) {
      expect(heads, h).toContain(h)
    }
    const adminLoc = locations.find((l) => l.head === '/api/admin/')
    expect(adminLoc?.body).toMatch(/client_max_body_size\s+256k/)
    expect(proxying.length).toBeGreaterThanOrEqual(12)
  })

  it('overrides all four Remote-* headers in every location that proxies to 8100 or 8099', () => {
    for (const loc of proxying) {
      for (const h of IDENTITY) {
        expect(loc.body, `${loc.head} must set ${h}`).toMatch(new RegExp(`proxy_set_header\\s+${h}\\s+(\\$\\w+|"")\\s*;`))
      }
    }
  })

  it('uses auth_request on every proxying location except the allow-list', () => {
    for (const loc of proxying) {
      if (AUTH_OPTIONAL.has(loc.head)) {
        expect(loc.body, loc.head).toMatch(/auth_request\s+off\s*;/)
        continue
      }
      expect(loc.body, `${loc.head} needs auth_request`).toMatch(/auth_request\s+\/internal\/authelia\/authz\s*;/)
      for (const v of ['user', 'groups', 'email', 'name']) {
        expect(loc.body, loc.head).toContain(`$upstream_http_remote_${v}`)
      }
    }
  })

  it('disables proxy buffering on /api/ai/ locations and keeps the 20 MB body size for uploads only', () => {
    const ai = locations.filter((l) => l.head.includes('/api/ai/'))
    expect(ai.length).toBeGreaterThanOrEqual(2)
    for (const loc of ai) expect(loc.body, loc.head).toMatch(/proxy_buffering\s+off\s*;/)
    const chat = locations.find((l) => l.head === '/api/ai/')
    const upload = locations.find((l) => l.head === '= /api/ai/upload')
    expect(chat?.body).toMatch(/client_max_body_size\s+64k/)
    expect(upload?.body).toMatch(/client_max_body_size\s+20m/)
    expect(chat?.body).toMatch(/limit_req\s+zone=lecture_ai/)

    const mcp = locations.find((l) => l.head === '= /api/mcp')
    expect(mcp?.body).toMatch(/proxy_buffering\s+off\s*;/)
    expect(mcp?.body).toMatch(/client_max_body_size\s+/)
    expect(mcp?.body).toMatch(/Remote-User\s+""\s*;/)
  })

  it('never serves the AI tool data files to browsers', () => {
    const tools = locations.find((l) => l.head === '~ ^/(?:_access/[^/]+/)?tools/')
    expect(tools?.body).toMatch(/return\s+404\s*;/)
    const re = /^\/(?:_access\/[^/]+\/)?tools\//
    for (const p of ['/tools/lectures.json', '/tools/tiers.json', '/_access/grp-1a2b3c4d/tools/concepts.json']) expect(re.test(p), p).toBe(true)
    for (const p of ['/api/tools/search_concepts', '/g01/tools-and-tricks', '/concepts/x']) expect(re.test(p), p).toBe(false)
  })

  it('routes the legacy Notion paths to 8099 and nothing else to it except /api/tool/', () => {
    const legacy = proxying.filter((l) => l.body.includes('lecture_legacy_backend')).map((l) => l.head).sort()
    expect(legacy).toEqual(['/api/notion/', '/api/progress/', '/api/tool/'])
  })

  it('keeps secrets out of the template: the tool token comes from an include file', () => {
    const tool = locations.find((l) => l.head === '/api/tool/')
    expect(tool?.body).toMatch(/include\s+\/etc\/nginx\/secrets\/[\w.-]+\s*;/)
    expect(text).not.toMatch(/Bearer\s+(?!REPLACE_WITH_TOOL_TOKEN)[A-Za-z0-9_-]{12,}/)
    // no real deployment host: only the documented placeholders (example.com) and the upstream services named in comments
    const hosts = (text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:win|com|net|org|io|cn|xyz|top)\b/g) ?? []).filter((h) => !/(^|\.)example\.com$/.test(h))
    expect(hosts).toEqual([])
  })

  it('marks the http-level and server-level sections', () => {
    expect(text).toContain('# ##### HTTP-LEVEL BEGIN #####')
    expect(text).toContain('# ##### SERVER-LEVEL BEGIN #####')
    const http = text.slice(text.indexOf('HTTP-LEVEL BEGIN'), text.indexOf('HTTP-LEVEL END'))
    expect(http).toContain('upstream lecture_api_backend')
    expect(http).toContain('limit_req_zone')
    expect(http).not.toContain('location ')
  })

  it('the parser itself flags a location that misses an override', () => {
    const broken = 'location /api/x/ { auth_request /internal/authelia/authz; proxy_set_header Remote-User $a; proxy_pass http://lecture_api_backend; }'
    const [loc] = parseLocations(broken)
    expect(loc?.body).not.toMatch(/proxy_set_header\s+Remote-Groups/)
  })
})
