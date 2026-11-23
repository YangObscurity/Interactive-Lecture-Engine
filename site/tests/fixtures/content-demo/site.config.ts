export default {
  theme: 'reader',
  themes: ['datasheet'],
  modules: {
    progress: { adapter: 'local' },
    companion: { adapter: 'off' },
    graph: { source: 'merge' },
    contentSync: { adapter: 'none' },
    auth: { adapter: 'none' },
  },
  access: {
    default: 'public',
    enforcement: 'none',
  },
  home: {
    map: 'atlas',
    atlasExpand: 'reading',
  },
  i18n: {
    root: 'zh-CN',
    locales: ['zh-CN', 'en'],
  },
}
