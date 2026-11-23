#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { cleanSyncedContent } from '../scripts/content/sync.mts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'content-demo')
const PORT = Number(process.env.E2E_DEV_PORT ?? 5311)
const SCRATCH_ROOT = path.join(os.tmpdir(), 'content-watch-check')
const TEMP_CONTENT = path.join(SCRATCH_ROOT, `watch-demo-${process.pid}`)

async function waitForHttp(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Server not listening yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Timed out waiting for dev server at ${url}`)
}

async function waitForWatcherReady(child, timeoutMs = 15000) {
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`content:watch did not become ready:\n${out}`)), timeoutMs)
    const onData = (chunk) => {
      out += chunk.toString('utf8')
      if (out.includes('[content:watch] watching')) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk) => {
      out += chunk.toString('utf8')
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`content:watch exited early (${code}):\n${out}`))
    })
  })
}

async function killProcessTree(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 3000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 1500)),
    ])
  }
}

async function main() {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true })
  fs.rmSync(TEMP_CONTENT, { recursive: true, force: true })
  fs.cpSync(FIXTURE_DIR, TEMP_CONTENT, { recursive: true })

  const env = {
    ...process.env,
    LECTURE_CONTENT_DIR: TEMP_CONTENT,
  }

  let watcher = null
  let devServer = null
  let browser = null
  const devLogs = []
  const watcherLogs = []

  try {
    watcher = spawn(process.execPath, ['scripts/content/watch.mts'], {
      cwd: SITE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    watcher.stdout?.on('data', (c) => watcherLogs.push(c.toString('utf8')))
    watcher.stderr?.on('data', (c) => watcherLogs.push(c.toString('utf8')))
    await waitForWatcherReady(watcher)

    devServer = spawn(
      process.execPath,
      [path.join(SITE_DIR, 'node_modules', 'vitepress', 'bin', 'vitepress.js'), 'dev', 'docs', '--port', String(PORT), '--host', '127.0.0.1'],
      {
        cwd: SITE_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    devServer.stdout?.on('data', (c) => devLogs.push(c.toString('utf8')))
    devServer.stderr?.on('data', (c) => devLogs.push(c.toString('utf8')))
    devServer.on('exit', (code, sig) => devLogs.push(`[devServer exited code=${code} sig=${sig}]\n`))

    const targetUrl = `http://127.0.0.1:${PORT}/demo-beta/L01`
    await waitForHttp(targetUrl)

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CI ? {} : { channel: 'chrome' }),
    })
    const page = await browser.newPage()
    const consoleLogs = []
    let viteConnected = false
    page.on('console', (msg) => {
      consoleLogs.push(`[browser ${msg.type()}] ${msg.text()}`)
      if (msg.text().includes('[vite] connected')) viteConnected = true
    })
    page.on('pageerror', (err) => {
      consoleLogs.push(`[browser pageerror] ${err.message}`)
    })
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 })
    await page.waitForFunction(() => document.body.innerText.includes('系统验证范围'), {
      timeout: 30000,
    })
    const wsDeadline = Date.now() + 10000
    while (!viteConnected && Date.now() < wsDeadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    const sentinel = `WATCH_LIVE_UPDATE_${Date.now()}`
    const fixtureLecture = path.join(TEMP_CONTENT, 'lectures', 'demo-beta', 'L01.md')
    const before = fs.readFileSync(fixtureLecture, 'utf8')
    fs.writeFileSync(fixtureLecture, `${before}\n\n${sentinel}\n`, 'utf8')

    // Wait until content:watch finishes copying the update
    const syncDeadline = Date.now() + 10000
    while (!watcherLogs.join('').includes('updated') && Date.now() < syncDeadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    let updatedLive = false
    try {
      await page.waitForFunction((token) => document.body.innerText.includes(token), sentinel, {
        timeout: 10000,
      })
      updatedLive = true
    } catch {
      console.error(`[content-watch-check] HMR not seen within 10s (viteConnected=${viteConnected}), reloading page; browser console:\n${consoleLogs.join('\n')}`)
      await page.reload({ waitUntil: 'load', timeout: 20000 })
      await page.waitForFunction((token) => document.body.innerText.includes(token), sentinel, {
        timeout: 15000,
      })
    }

    process.stdout.write(
      `[content-watch-check] PASS: dev server showed edited lecture (${sentinel}, viteConnected=${viteConnected}, updatedLive=${updatedLive})\n`,
    )
  } catch (err) {
    if (watcherLogs.length > 0) console.error(`[content-watch-check] watcher logs:\n${watcherLogs.join('')}`)
    if (devLogs.length > 0) console.error(`[content-watch-check] dev server logs:\n${devLogs.join('')}`)
    throw err
  } finally {
    if (browser) await browser.close().catch(() => {})
    await killProcessTree(devServer)
    await killProcessTree(watcher)
    cleanSyncedContent({ quiet: true })
    fs.rmSync(TEMP_CONTENT, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`[content-watch-check] FAIL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
