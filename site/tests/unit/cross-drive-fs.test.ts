import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossDriveAssetPath, linkedNodeModules, servedDrive } from '../../docs/.vitepress/plugins/crossDriveFsPlugin.mts'

// a /@fs URL on drive `d` (built, so the source holds no literal machine paths)
const at = (d: string, rest: string): string => '/@fs/' + d + ':/' + rest
const FONT = at('C', 'deps/site/node_modules/@fontsource-variable/noto-sans-sc/files/a-wght-normal.woff2')

describe('crossDriveFsPlugin', () => {
  it('takes a /@fs font on another drive than the served one', () => {
    expect(crossDriveAssetPath(FONT, { platform: 'win32', drive: 'G' })).toEqual({
      file: 'C' + ':\\' + ['deps', 'site', 'node_modules', '@fontsource-variable', 'noto-sans-sc', 'files', 'a-wght-normal.woff2'].join('\\'),
      mime: 'font/woff2',
    })
    expect(crossDriveAssetPath(at('c', 'x/y%20z.png'), { platform: 'win32', drive: 'G' })?.file).toBe('c' + ':\\x\\y z.png')
  })

  it('leaves everything else to Vite', () => {
    // same drive: Vite's own handler finds it
    expect(crossDriveAssetPath(FONT, { platform: 'win32', drive: 'c' })).toBeNull()
    // not Windows
    expect(crossDriveAssetPath(FONT, { platform: 'linux', drive: '' })).toBeNull()
    expect(crossDriveAssetPath(FONT, { platform: 'darwin', drive: 'G' })).toBeNull()
    // modules and queries go through the transform middleware
    expect(crossDriveAssetPath(at('C', 'deps/node_modules/vue/index.js'), { platform: 'win32', drive: 'G' })).toBeNull()
    expect(crossDriveAssetPath(at('C', 'deps/node_modules/x/a.css'), { platform: 'win32', drive: 'G' })).toBeNull()
    expect(crossDriveAssetPath(`${FONT}?import`, { platform: 'win32', drive: 'G' })).toBeNull()
    expect(crossDriveAssetPath(at('C', 'deps/.env'), { platform: 'win32', drive: 'G' })).toBeNull()
    // not /@fs, or no drive letter
    expect(crossDriveAssetPath('/node_modules/a.woff2', { platform: 'win32', drive: 'G' })).toBeNull()
    expect(crossDriveAssetPath('/@fs/deps/a.woff2', { platform: 'win32', drive: 'G' })).toBeNull()
    expect(crossDriveAssetPath(at('C', '%E0%A4%A.woff2'), { platform: 'win32', drive: 'G' })).toBeNull()
  })

  it('reads the served drive from the root path.resolve gives', () => {
    expect(servedDrive(() => 'g:\\')).toBe('G')
    expect(servedDrive(() => '/')).toBe('')
  })

  it('lists node_modules folders that are links, with their real path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xdrive-'))
    try {
      const real = path.join(tmp, 'deps', 'node_modules')
      const site = path.join(tmp, 'repo', 'site')
      fs.mkdirSync(real, { recursive: true })
      fs.mkdirSync(path.join(site, 'docs'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'repo', 'node_modules'))
      fs.symlinkSync(real, path.join(site, 'node_modules'), 'junction')
      const inTmp = path.resolve(fs.realpathSync.native(tmp)).toLowerCase()
      const found = linkedNodeModules(path.join(site, 'docs'))
        .map((p) => path.resolve(p).toLowerCase())
        .filter((p) => p.startsWith(inTmp)) // ignore any linked node_modules above the temp folder
      expect(found).toEqual([path.resolve(fs.realpathSync.native(real)).toLowerCase()])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
