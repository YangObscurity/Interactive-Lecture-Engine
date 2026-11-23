import { describe, expect, it } from 'vitest'
import { trimTrailingSlashes } from '../../src/http/url.js'

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(trimTrailingSlashes('https://api.example.com/v1///')).toBe('https://api.example.com/v1')
    expect(trimTrailingSlashes('https://api.example.com/v1')).toBe('https://api.example.com/v1')
    expect(trimTrailingSlashes('/a//b/')).toBe('/a//b')
    expect(trimTrailingSlashes('///')).toBe('')
    expect(trimTrailingSlashes('')).toBe('')
  })

  it('matches the old replace(/\\/+$/, "") on mixed input', () => {
    for (const s of ['x', 'x/', '/x/', 'a/b//', '//a', 'a/ /', 'a\\/']) expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''))
  })

  it('is linear on a long run of slashes that does not end the string', () => {
    const s = '/'.repeat(200_000) + 'x'
    const t = Date.now()
    expect(trimTrailingSlashes(s)).toBe(s)
    expect(Date.now() - t).toBeLessThan(50)
  })
})
