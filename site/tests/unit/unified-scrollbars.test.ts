import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../docs/.vitepress')

describe('unified theme scrollbar stylesheet contract', () => {
  it('loads scrollbars.css in theme/index.ts after base.css using contract tokens and zero stepper buttons', () => {
    const indexTs = fs.readFileSync(path.join(ROOT, 'theme/index.ts'), 'utf8')
    const baseIdx = indexTs.indexOf("./styles/base.css'")
    const sbIdx = indexTs.indexOf("./styles/scrollbars.css'")
    expect(baseIdx).toBeGreaterThan(-1)
    expect(sbIdx).toBeGreaterThan(baseIdx)

    const css = fs.readFileSync(path.join(ROOT, 'theme/styles/scrollbars.css'), 'utf8')
    expect(css).toMatch(/:where\(\*\)::-webkit-scrollbar-button\s*\{[^}]*display:\s*none\s*;/)
    expect(css).toContain('var(--lec-text-muted)')
    expect(css).toContain('var(--lec-text)')
    expect(css).toContain('var(--lec-accent)')
    expect(css).toContain('@supports not selector(::-webkit-scrollbar)')
  })

  it('governs datasheet scrollbar radius from themes/datasheet/theme.css and does not clamp Chromium in ChatContainer', () => {
    const dsCss = fs.readFileSync(path.join(ROOT, 'themes/datasheet/theme.css'), 'utf8')
    expect(dsCss).toContain("::-webkit-scrollbar-thumb")
    expect(dsCss).toContain("border-radius: 1px")

    const chatCss = fs.readFileSync(path.join(ROOT, 'theme/components/ai/ChatContainer.vue'), 'utf8')
    expect(chatCss).not.toMatch(/scrollbar-width:\s*thin/)
  })
})
