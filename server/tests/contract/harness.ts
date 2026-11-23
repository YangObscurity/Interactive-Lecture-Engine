import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type AuthMode = 'none' | 'trusted-header'

export interface ServerHarness {
  baseUrl: string
  authMode: AuthMode
  stop: () => Promise<void>
}

/**
 * Finds a free ephemeral port by temporarily binding a TCP socket on 127.0.0.1:0.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (!addr || typeof addr === 'string') {
        s.close()
        rej(new Error('Failed to obtain server address'))
        return
      }
      const port = addr.port
      s.close((err) => {
        if (err) rej(err)
        else res(port)
      })
    })
    s.on('error', rej)
  })
}

/**
 * Polls the health endpoint until it responds with HTTP 200 or times out.
 */
export async function waitForHealth(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.status === 200) {
        return
      }
    } catch {
      // Server not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health after ${timeoutMs}ms`)
}

/**
 * Probes the running server to determine whether AUTH_ADAPTER is 'none' or 'trusted-header'.
 */
export async function detectAuthMode(baseUrl: string): Promise<AuthMode> {
  if (process.env.CONTRACT_AUTH_MODE === 'none') {
    return 'none'
  }
  if (process.env.CONTRACT_AUTH_MODE === 'trusted-header') {
    return 'trusted-header'
  }

  const res = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { 'Remote-User': '__contract_mode_probe__' },
  })
  if (!res.ok) {
    throw new Error(
      `Failed to probe auth mode from ${baseUrl}/api/auth/session: received status ${res.status}`,
    )
  }
  const data = (await res.json()) as { authenticated?: boolean }
  return data.authenticated === true ? 'trusted-header' : 'none'
}

/**
 * Spawns a background Node.js server process (node dist/index.js) on a free port
 * with an isolated temporary PGlite database and DB_AUTO_MIGRATE=true.
 */
export async function spawnTestServer(options: {
  authAdapter: AuthMode
  authHeaderPreset?: string
  authRoleMap?: string
  extraEnv?: Record<string, string>
}): Promise<ServerHarness> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const serverRootDir = resolve(currentDir, '../..')
  const distIndexPath = resolve(serverRootDir, 'dist/index.js')

  if (!existsSync(distIndexPath)) {
    throw new Error(
      `Compiled server entrypoint not found at ${distIndexPath}. Please run 'npm run build' before executing contract tests.`,
    )
  }

  const port = await getFreePort()
  const tempDir = mkdtempSync(join(tmpdir(), `lecture-api-contract-${options.authAdapter}-`))

  const child: ChildProcess = spawn(process.execPath, [distIndexPath], {
    cwd: serverRootDir,
    env: {
      ...process.env,
      DATABASE_URL: `pglite:${tempDir}`,
      DB_AUTO_MIGRATE: 'true',
      HOST: '127.0.0.1',
      PORT: String(port),
      AUTH_ADAPTER: options.authAdapter,
      AUTH_HEADER_PRESET: options.authHeaderPreset ?? 'authelia',
      AUTH_ROLE_MAP: options.authRoleMap ?? 'admins:admin,staff:author',
      LOG_LEVEL: 'warn',
      ...(options.extraEnv ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderrOutput = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrOutput += chunk.toString()
  })

  let exited = false
  let exitCode: number | null = null
  child.on('exit', (code) => {
    exited = true
    exitCode = code
  })

  const baseUrl = `http://127.0.0.1:${port}`

  // Poll /api/health with premature crash detection
  const start = Date.now()
  const timeoutMs = 15000
  let ready = false

  while (Date.now() - start < timeoutMs) {
    if (exited) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      throw new Error(
        `Server process exited prematurely with code ${exitCode}. Stderr:\n${stderrOutput}`,
      )
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.status === 200) {
        ready = true
        break
      }
    } catch {
      // wait and retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  if (!ready) {
    child.kill('SIGKILL')
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw new Error(
      `Timed out waiting for server on ${baseUrl} to become healthy. Stderr:\n${stderrOutput}`,
    )
  }

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (!exited) {
      child.kill('SIGTERM')
      const exitPromise = new Promise<void>((resolveExit) => {
        child.on('exit', () => resolveExit())
      })
      const timeoutPromise = new Promise<void>((resolveTimeout) => {
        setTimeout(() => {
          if (!exited) {
            child.kill('SIGKILL')
          }
          resolveTimeout()
        }, 3000)
      })
      await Promise.race([exitPromise, timeoutPromise])
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  // Orphan cleanup safeguard
  process.on('exit', () => {
    if (!exited) {
      try {
        child.kill('SIGKILL')
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  return {
    baseUrl,
    authMode: options.authAdapter,
    stop,
  }
}
