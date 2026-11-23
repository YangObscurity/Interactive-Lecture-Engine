import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { parseEnv } from '../../src/config/env.js'
import { createDb, type Db } from '../../src/db/index.js'
import {
  backupEnvFile,
  MutableOutput,
  parseServerVersion,
  runSetupCli,
} from '../../scripts/setup.js'

describe('Setup Wizard (scripts/setup.ts)', () => {
  const tempDirs: string[] = []
  const dbsToClose: Db[] = []
  const streamsToClean: PassThrough[] = []

  function makeTempDir(prefix = 'setup-test-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  function createInteractiveIo(answers: string[]) {
    const stdin = new PassThrough()
    streamsToClean.push(stdin)
    const capturedChunks: string[] = []
    let answerIndex = 0

    const stdout = new Writable({
      write(chunk: unknown, _enc, cb) {
        const str = typeof chunk === 'string' ? chunk : String(chunk)
        capturedChunks.push(str)
        const isPrompt = !str.endsWith('\n') && /[:：?？]\s*$/.test(str)
        if (isPrompt && answerIndex < answers.length) {
          const next = answers[answerIndex++]!
          setImmediate(() => {
            stdin.write(next + '\n')
          })
        }
        cb()
      },
    })

    return { stdin, stdout, capturedChunks }
  }

  afterEach(async () => {
    while (streamsToClean.length > 0) {
      const s = streamsToClean.pop()
      if (s && !s.destroyed) {
        s.destroy()
      }
    }
    while (dbsToClose.length > 0) {
      const db = dbsToClose.pop()
      if (db) {
        await db.close().catch(() => {})
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  describe('R7 Core Acceptance Tests', () => {
    it('R7.a: sentinel secret typed into wizard never appears in captured terminal output', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const sentinel = 'SENTINEL_SECRET_SUPER_PW_987654321'
      const dbPath = join(dir, `store_${sentinel}`)

      const answers = [
        `pglite:${dbPath}`, // DATABASE_URL
        '', // DATABASE_URL_DIRECT
        '', // HOST
        '', // PORT
        '', // AUTH_ADAPTER
        '', // NOTION_HEALTH_URL
        '', // LOG_LEVEL
        'n', // migration prompt
        'n', // DB_AUTO_MIGRATE prompt
      ]

      const { stdin, stdout, capturedChunks } = createInteractiveIo(answers)

      const exitCode = await runSetupCli([], {
        stdin,
        stdout,
        envFile: envPath,
      })
      expect(exitCode).toBe(0)

      const allOutput = capturedChunks.join('')

      // Crucial requirement: sentinel secret typed into the wizard NEVER appears in captured terminal output
      expect(allOutput).not.toContain(sentinel)
      expect(allOutput).not.toContain('987654321')
      expect(allOutput).not.toContain('SUPER_PW')

      // Also directly verify MutableOutput drops all chunks when muted = true
      const testSink: string[] = []
      const targetSink = new Writable({
        write(chunk: unknown, _enc, cb) {
          testSink.push(String(chunk))
          cb()
        },
      })
      const mutable = new MutableOutput(targetSink)
      mutable.muted = true
      mutable.write(`my-secret-key-${sentinel}`)
      expect(testSink).toEqual([])
      mutable.muted = false
      mutable.write('visible-chunk')
      expect(testSink).toEqual(['visible-chunk'])
    })

    it('R7.b: CRLF .env stays CRLF after rewrite', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const pgliteDir = join(dir, 'pglite_crlf')
      const initialCrlf = `# Existing header comment\r\nHOST=127.0.0.1\r\nPORT=8100\r\n# Inline comments\r\nDATABASE_URL=pglite:${pgliteDir}\r\n`
      writeFileSync(envPath, initialCrlf, 'utf8')

      const exitCode = await runSetupCli(['--yes', '--no-init-db'], {
        envFile: envPath,
      })
      expect(exitCode).toBe(0)

      const rewritten = readFileSync(envPath, 'utf8')
      // Must contain \r\n
      expect(rewritten).toContain('\r\n')
      // Every single newline must be preceded by \r (no lone \n)
      expect(rewritten.replace(/\r\n/g, '')).not.toContain('\n')
      // Comments must be preserved
      expect(rewritten).toContain('# Existing header comment')
      expect(rewritten).toContain('# Inline comments')

      // A backup file .env.bak-<timestamp> must have been created
      const files = readdirSync(dir)
      const backups = files.filter((f) => f.startsWith('.env.bak-'))
      expect(backups.length).toBeGreaterThan(0)

      const backupContent = readFileSync(join(dir, backups[0]!), 'utf8')
      expect(backupContent).toBe(initialCrlf)
    })

    it('R7.c: value containing " #" round-trips', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const pgliteDir = join(dir, 'pglite_hash')
      const trickyVal = 'admins:admin,auditors:reader # not a comment'

      // First run: save AUTH_ROLE_MAP containing ' #'
      const exitCode1 = await runSetupCli(['--yes', '--no-init-db'], {
        envFile: envPath,
        env: {
          DATABASE_URL: `pglite:${pgliteDir}`,
          AUTH_ROLE_MAP: trickyVal,
        },
      })
      expect(exitCode1).toBe(0)

      const writtenText = readFileSync(envPath, 'utf8')
      // Value must be quoted in the serialized file to protect the ' #'
      expect(writtenText).toContain(`AUTH_ROLE_MAP="${trickyVal}"`)

      // Parse with parseEnv to verify it round-trips identically
      const parsed1 = parseEnv(writtenText)
      expect(parsed1.AUTH_ROLE_MAP).toBe(trickyVal)

      // Re-run setup against the existing file to verify rewrite stability
      const exitCode2 = await runSetupCli(['--yes', '--no-init-db'], {
        envFile: envPath,
      })
      expect(exitCode2).toBe(0)

      const rewrittenText = readFileSync(envPath, 'utf8')
      const parsed2 = parseEnv(rewrittenText)
      expect(parsed2.AUTH_ROLE_MAP).toBe(trickyVal)
    })

    it('R7.d: answering n creates no tables', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const pgliteDir = join(dir, 'pglite_no_init')
      const dbUrl = `pglite:${pgliteDir}`

      // Run setup with interactive input answering 'n' to "现在初始化数据库表吗？[y/N]"
      const answers = [
        dbUrl, // DATABASE_URL
        '', // DATABASE_URL_DIRECT
        '', // HOST
        '', // PORT
        '', // AUTH_ADAPTER
        '', // NOTION_HEALTH_URL
        '', // LOG_LEVEL
        'n', // migration -> n (NO!)
        'n', // DB_AUTO_MIGRATE -> n
      ]

      const { stdin, stdout } = createInteractiveIo(answers)

      const exitCode = await runSetupCli([], {
        stdin,
        stdout,
        envFile: envPath,
      })
      expect(exitCode).toBe(0)

      // Connect to the database directly and verify no tables exist
      const checkDb = createDb(dbUrl)
      dbsToClose.push(checkDb)

      const progressReg = await checkDb.query<{ reg: string | null }>(
        "SELECT to_regclass('public.progress') AS reg;",
      )
      const migrationsReg = await checkDb.query<{ reg: string | null }>(
        "SELECT to_regclass('public.schema_migrations') AS reg;",
      )
      const idempotencyReg = await checkDb.query<{ reg: string | null }>(
        "SELECT to_regclass('public.idempotency_keys') AS reg;",
      )

      expect(progressReg.rows[0]?.reg).toBeNull()
      expect(migrationsReg.rows[0]?.reg).toBeNull()
      expect(idempotencyReg.rows[0]?.reg).toBeNull()
    })

    it('creates tables when answering y or passing --init-db', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const pgliteDir = join(dir, 'pglite_with_init')
      const dbUrl = `pglite:${pgliteDir}`

      const exitCode = await runSetupCli(['--yes', '--init-db'], {
        envFile: envPath,
        env: {
          DATABASE_URL: dbUrl,
        },
      })
      expect(exitCode).toBe(0)

      const checkDb = createDb(dbUrl)
      dbsToClose.push(checkDb)

      const progressReg = await checkDb.query<{ reg: string | null }>(
        "SELECT to_regclass('public.progress') AS reg;",
      )
      const migrationsReg = await checkDb.query<{ reg: string | null }>(
        "SELECT to_regclass('public.schema_migrations') AS reg;",
      )

      expect(progressReg.rows[0]?.reg).not.toBeNull()
      expect(migrationsReg.rows[0]?.reg).not.toBeNull()

      const migrations = await checkDb.query<{ version: number; name: string }>(
        'SELECT version, name FROM public.schema_migrations;',
      )
      expect(migrations.rows.length).toBeGreaterThan(0)
    })
  })

  describe('Non-interactive flags and validations', () => {
    it('rejects conflicting --init-db and --no-init-db flags', async () => {
      const errors: string[] = []
      const exitCode = await runSetupCli(['--init-db', '--no-init-db'], {
        error: (msg) => errors.push(msg),
      })
      expect(exitCode).toBe(1)
      expect(errors.join(' ')).toContain('不能同时指定 --init-db 与 --no-init-db')
    })

    it('fails with exit code 1 if DATABASE_URL is missing in non-interactive mode', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const errors: string[] = []

      const exitCode = await runSetupCli(['--yes', '--no-init-db'], {
        envFile: envPath,
        env: {
          DATABASE_URL: undefined,
        },
        error: (msg) => errors.push(msg),
      })
      expect(exitCode).toBe(1)
      expect(errors.join(' ')).toContain('DATABASE_URL 为必填项')
    })

    it('fails with exit code 1 and redacts secrets if database connection fails', async () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      const errors: string[] = []
      const secretPw = 'secret_pw_cannot_connect_9988'

      const exitCode = await runSetupCli(['--yes', '--no-init-db'], {
        envFile: envPath,
        env: {
          DATABASE_URL: `postgresql://user:${secretPw}@127.0.0.1:54321/nonexistent_db`,
        },
        error: (msg) => errors.push(msg),
      })
      expect(exitCode).toBe(1)
      const errText = errors.join(' ')
      expect(errText).toContain('数据库连接失败')
      expect(errText).not.toContain(secretPw)
    })

    it('shows help text with --help', async () => {
      const logs: string[] = []
      const exitCode = await runSetupCli(['--help'], {
        log: (msg) => logs.push(msg),
      })
      expect(exitCode).toBe(0)
      expect(logs.join('\n')).toContain('用法: npm run setup')
    })
  })

  describe('parseServerVersion & backupEnvFile unit tests', () => {
    it('correctly parses PGlite version', () => {
      const raw =
        'PostgreSQL 18.6 (PGlite 0.5.16) on wasm32-unknown-emscripten, compiled by emcc'
      const info = parseServerVersion(raw, 'pglite:memory')
      expect(info.kind).toBe('PGlite')
      expect(info.version).toBe('0.5.16')
      expect(info.display).toBe('PGlite 0.5.16')
      expect(info.isPooled).toBe(false)
    })

    it('correctly parses PostgreSQL direct connection without exposing host', () => {
      const raw =
        'PostgreSQL 16.2 (Debian 16.2-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc'
      const url = 'postgresql://user:pw@ep-direct.ap-southeast-1.aws.neon.tech:5432/lecture'
      const info = parseServerVersion(raw, url)
      expect(info.kind).toBe('PostgreSQL')
      expect(info.version).toBe('16.2')
      expect(info.display).toBe('PostgreSQL 16.2 (直连模式 / direct)')
      expect(info.display).not.toContain('ep-direct')
      expect(info.display).not.toContain('neon.tech')
      expect(info.isPooled).toBe(false)
    })

    it('correctly detects Neon connection pooler and annotates display', () => {
      const raw = 'PostgreSQL 16.4 on x86_64-pc-linux-gnu'
      const url = 'postgresql://user:pw@ep-pooler.ap-southeast-1.aws.neon.tech:5432/lecture'
      const info = parseServerVersion(raw, url)
      expect(info.kind).toBe('PostgreSQL')
      expect(info.version).toBe('16.4')
      expect(info.display).toBe('PostgreSQL 16.4 (连接池模式 / pooled)')
      expect(info.isPooled).toBe(true)
    })

    it('backupEnvFile returns null if file does not exist', () => {
      const res = backupEnvFile('/non/existent/path/.env')
      expect(res).toBeNull()
    })

    it('backupEnvFile creates backup with timestamp', () => {
      const dir = makeTempDir()
      const envPath = join(dir, '.env')
      writeFileSync(envPath, 'PORT=8100\n', 'utf8')
      const fixedDate = new Date('2026-11-18T19:30:45Z')
      const backup = backupEnvFile(envPath, fixedDate)
      expect(backup).not.toBeNull()
      expect(backup).toContain('.env.bak-2026')
      expect(existsSync(backup!)).toBe(true)
      expect(readFileSync(backup!, 'utf8')).toBe('PORT=8100\n')
    })
  })
})
