// wavedrom ships no type declarations; the renderer narrows the module itself.
declare module 'wavedrom' {
  const wavedrom: unknown
  export default wavedrom
}

declare module 'wavedrom/skins/dark.js' {
  const skin: unknown
  export default skin
}
