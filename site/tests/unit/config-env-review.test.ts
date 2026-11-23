// Regression tests added in review of WP-C2 (2026-11-18): secrets typed into `setup` must never be echoed,
// and rewriting .env must keep the file's line endings and write values that read back unchanged.
import { PassThrough } from 'node:stream'
import readlinePromises from 'node:readline/promises'
import { describe, expect, it } from 'vitest'
import { formatEnvValue, parseEnv, updateEnvText } from '../../scripts/config/env.mts'
import { MutableOutput, promptLine } from '../../scripts/config/setup.mts'

function fakeTty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => PassThrough }
  input.isTTY = true
  input.setRawMode = () => input
  const screen = new PassThrough()
  let shown = ''
  screen.on('data', (c: Buffer) => { shown += c.toString() })
  const out = new MutableOutput(screen)
  const rl = readlinePromises.createInterface({ input, output: out, terminal: true })
  return { input, rl, out, shown: () => shown }
}

describe('setup secret prompt', () => {
  it('returns what was typed and never shows it', async () => {
    const t = fakeTty()
    const answer = promptLine(t.rl, 'Token: ', true, t.out)
    setTimeout(() => t.input.write('SENTINEL_TYPED_77\r'), 10)
    expect(await answer).toBe('SENTINEL_TYPED_77')
    t.rl.close()
    expect(t.shown()).toContain('Token: ')
    expect(t.shown()).not.toContain('SENTINEL_TYPED_77')
  })

  it('echoes normal answers and unmutes after a secret', async () => {
    const t = fakeTty()
    const s = promptLine(t.rl, 'Secret: ', true, t.out)
    setTimeout(() => t.input.write('hidden_77\r'), 10)
    await s
    const n = promptLine(t.rl, 'Name: ', false, t.out)
    setTimeout(() => t.input.write('visible_77\r'), 10)
    expect(await n).toBe('visible_77')
    t.rl.close()
    expect(t.shown()).toContain('visible_77')
    expect(t.shown()).not.toContain('hidden_77')
  })
})

describe('.env rewriting', () => {
  it('keeps CRLF line endings and every unrelated line byte for byte', () => {
    const before = '# 部署\r\nDEPLOY_USER=old\r\nOTHER=keep me # note\r\n\r\n# end\r\n'
    const after = updateEnvText(before, { DEPLOY_USER: 'new' })
    expect(after).toBe('# 部署\r\nDEPLOY_USER=new\r\nOTHER=keep me # note\r\n\r\n# end\r\n')
  })

  it('keeps LF files LF', () => {
    expect(updateEnvText('A=1\nB=2\n', { B: '3' })).toBe('A=1\nB=3\n')
  })

  it.each([
    ['plain', 'abc'],
    ['windows path', String.raw`C:\Users\me\.ssh\id_ed25519`],
    ['space hash (would be an inline comment)', String.raw`C:\My #1\key`],
    ['leading and trailing spaces', '  padded  '],
    ['starts with a double quote', '"quoted'],
    ['starts with a single quote', "'quoted"],
    ['contains a double quote', 'say "hi" #x'],
    ['multi-line PEM', '-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----'],
  ])('%s survives write then read', (_name, value) => {
    const text = updateEnvText('# head\n', { DEPLOY_SSH_KEY_PEM: value })
    expect(parseEnv(text).DEPLOY_SSH_KEY_PEM).toBe(value)
  })

  it('writes both quote kinds plainly when no quoting is needed, refuses them when it is', () => {
    expect(formatEnvValue(`it's "both"`)).toBe(`it's "both"`)
    expect(parseEnv(`K=${formatEnvValue(`it's "both"`)}`).K).toBe(`it's "both"`)
    expect(() => formatEnvValue(`"it's" #x`)).toThrow()
  })
})
