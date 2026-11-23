import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'
import readlinePromises from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  MODULES,
  settingsOf,
  type ModuleId,
} from '../../config/schema.ts'
import {
  display,
  getInUseModules,
  loadSources,
  resolveAll,
  updateEnvText,
  validate,
} from './env.mts'
import { runDoctor, formatDoctorText, type ProbeRunner, defaultProbeRunner } from './doctor.mts'
import { resolveModules } from '../../docs/.vitepress/lecture-config.mts'
import { loadLectureConfig } from '../../docs/.vitepress/content/config.mts'

const __filename = fileURLToPath(import.meta.url)

export interface SetupOptions {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout?: NodeJS.WritableStream
  repoRoot?: string
  probeRunner?: ProbeRunner
}

/**
 * Output wrapper for the readline interface. While `muted`, nothing readline writes reaches the terminal, so the
 * characters it echoes for a secret are never shown (readline still does the line editing in raw mode).
 */
export class MutableOutput extends Writable {
  muted = false
  constructor(readonly target: NodeJS.WritableStream) {
    super()
  }
  get columns(): number | undefined {
    return (this.target as { columns?: number }).columns
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // Writable decodes strings to Buffers by default, so chunk is always a Buffer here
    if (!this.muted) this.target.write(chunk)
    callback()
  }
}

/**
 * Reads one line. For a secret, the prompt goes straight to the terminal and readline's echo is muted until the
 * line is entered, so nothing typed is displayed.
 */
export async function promptLine(
  rl: readlinePromises.Interface,
  promptText: string,
  isSecret = false,
  out?: MutableOutput
): Promise<string> {
  if (!isSecret || !out) return await rl.question(promptText)
  out.target.write(promptText)
  out.muted = true
  try {
    return await rl.question('')
  } finally {
    out.muted = false
    out.target.write('\n')
  }
}

export async function runSetup(options?: SetupOptions): Promise<number> {
  const stdin = options?.stdin ?? process.stdin
  const stdout = options?.stdout ?? process.stdout

  // If stdin is not a TTY, print instructions and exit 2
  if (!stdin.isTTY) {
    stdout.write(
      'npm run setup 需要交互式终端 (TTY)。\n' +
        '非交互环境下请复制模板并配置：\n' +
        '  cp .env.example .env\n' +
        '配置完成后运行体检工具验证：\n' +
        '  npm run doctor\n'
    )
    return 2
  }

  // terminal: true puts the TTY in raw mode, so the terminal itself never echoes; readline's own echo goes
  // through `out`, which promptLine mutes while a secret is typed
  const out = new MutableOutput(stdout)
  const rl = readlinePromises.createInterface({
    input: stdin,
    output: out,
    terminal: true,
  })

  try {
    const sources = loadSources({ repoRoot: options?.repoRoot })
    const siteConfig = loadLectureConfig()
    const siteMods = resolveModules(siteConfig)
    const resolved = resolveAll(sources)
    const resolvedMap = new Map(resolved.map((r) => [r.key, r]))
    const inUseSet = getInUseModules(resolved, siteMods)

    stdout.write('\n═══════════════════════════════════════════════════════════════════════════════\n')
    stdout.write('  Tutorial V2 讲义引擎配置向导 (setup)\n')
    stdout.write('═══════════════════════════════════════════════════════════════════════════════\n\n')

    // 1. List tool modules
    const toolModules = MODULES.filter((m) => !m.site)
    stdout.write('可选工具/运维模块：\n')
    for (let i = 0; i < toolModules.length; i++) {
      const mod = toolModules[i]!
      const mark = inUseSet.has(mod.id) ? '● 正在使用' : '○ 未使用'
      stdout.write(`  ${i + 1}) [${mark}] ${mod.title.zh} (${mod.id}) — ${mod.summary.zh}\n`)
    }
    stdout.write('\n')

    const choiceRaw = await promptLine(
      rl,
      '请选择要配置的模块编号（多个用逗号或空格分隔，输入 all 全选，回车跳过）: '
    )

    const pickedModules: ModuleId[] = []
    const trimmedChoice = choiceRaw.trim().toLowerCase()

    if (trimmedChoice === 'all') {
      for (const m of toolModules) pickedModules.push(m.id)
    } else if (trimmedChoice !== '') {
      const tokens = trimmedChoice.split(/[,\s]+/)
      for (const t of tokens) {
        const idx = parseInt(t, 10) - 1
        if (idx >= 0 && idx < toolModules.length) {
          pickedModules.push(toolModules[idx]!.id)
        }
      }
    }

    if (pickedModules.length === 0) {
      stdout.write('未选择任何工具模块，退出向导。\n')
      rl.close()
      return 0
    }

    const updates: Record<string, string> = {}
    const probeRunner = options?.probeRunner ?? defaultProbeRunner

    for (const modId of pickedModules) {
      const modSpec = MODULES.find((m) => m.id === modId)!
      stdout.write(`\n─────────────────────────────────────────────────────────────────────────────\n`)
      stdout.write(`配置模块：${modSpec.title.zh} (${modSpec.id})\n`)
      stdout.write(`─────────────────────────────────────────────────────────────────────────────\n`)

      const settings = settingsOf(modId).filter((s) => s.kind !== 'site')

      for (const s of settings) {
        const currentRes = resolvedMap.get(s.key)
        const currentVal = currentRes?.value
        const dispVal = display(s, currentVal)

        stdout.write(`\n• ${s.key} (${s.description.zh})\n`)
        if (s.kind === 'secret') {
          stdout.write('  [秘密项：输入时不回显内容]\n')
        }
        if (s.aliases && s.aliases.length > 0) {
          stdout.write(`  [别名兼容: ${s.aliases.join(', ')}]\n`)
        }
        stdout.write(`  当前值: ${dispVal}\n`)

        let valid = false
        let finalValue = currentVal

        while (!valid) {
          const ans = await promptLine(
            rl,
            `  输入新值 (回车保持当前值, '-' 清空): `,
            s.kind === 'secret',
            out
          )

          if (ans === '') {
            // Keep current value
            finalValue = currentVal
            valid = true
          } else if (ans === '-') {
            // Clear value
            finalValue = ''
            const vCheck = validate(s, finalValue)
            if (!vCheck.valid) {
              stdout.write(`  ✗ 校验失败: ${vCheck.error}，请重新输入\n`)
            } else {
              valid = true
            }
          } else {
            const vCheck = validate(s, ans)
            if (!vCheck.valid) {
              stdout.write(`  ✗ 校验失败: ${vCheck.error}，请重新输入\n`)
            } else {
              finalValue = ans
              valid = true
            }
          }
        }

        if (finalValue !== currentVal) {
          updates[s.key] = finalValue ?? ''
          // Update local map for subsequent checks/probes
          resolvedMap.set(s.key, {
            key: s.key,
            value: finalValue,
            source: '.env',
            nameUsed: s.key,
            isSet: Boolean(finalValue && finalValue !== ''),
          })
        }

        // Offer probe if applicable
        if (s.probe && finalValue && finalValue !== '') {
          const runProbeChoice = await promptLine(
            rl,
            `  是否对此项立即进行网络连通性测试 (${s.probe})？(y/N): `
          )
          if (runProbeChoice.trim().toLowerCase() === 'y') {
            stdout.write(`  正在探测 ${s.probe}... `)
            const pRes = await probeRunner(s.probe, s, resolvedMap)
            if (pRes.reachable) {
              stdout.write(`✓ 可达${pRes.status ? ` (HTTP ${pRes.status})` : ''}\n`)
            } else {
              stdout.write(`✗ 失败: ${pRes.error || '无法连通'}\n`)
            }
          }
        }
      }
    }

    // Update LECTURE_MODULES
    const currentLectureModules = resolvedMap.get('LECTURE_MODULES')?.value || ''
    const currentList = currentLectureModules
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    const mergedList = Array.from(new Set([...currentList, ...pickedModules])).filter(
      (m) => m !== 'meta'
    )
    updates['LECTURE_MODULES'] = mergedList.join(',')

    // Write to repo root .env
    const root = sources.repoRoot
    const envPath = resolve(root, '.env')
    let existingText = ''
    if (existsSync(envPath)) {
      existingText = readFileSync(envPath, 'utf8')
    }

    const updatedText = updateEnvText(existingText, updates)
    writeFileSync(envPath, updatedText, 'utf8')

    // Set chmod 600 on POSIX
    try {
      chmodSync(envPath, 0o600)
    } catch {
      // Ignore on Windows
    }

    stdout.write(`\n✓ 配置已成功写入: ${envPath}\n\n`)

    // Print doctor summary for picked modules
    stdout.write('重新评估当前配置状态：\n')
    const finalDoctor = await runDoctor({ sources: loadSources({ repoRoot: root }) })
    stdout.write(formatDoctorText(finalDoctor))
    stdout.write('\n')

    rl.close()
    return 0
  } catch (err: unknown) {
    rl.close()
    const errMsg = err instanceof Error ? err.message : String(err)
    stdout.write(`\n向导中断: ${errMsg}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const code = await runSetup()
  if (code !== 0) process.exit(code)
}
