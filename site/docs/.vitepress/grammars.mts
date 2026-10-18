/**
 * grammars.mts — Shiki 自定义语法（VitePress markdown.languages 只做「预加载」，
 * 其它 Shiki 内置语言会按需动态加载；这里补的是 Shiki **没有**的两种）。
 *
 * 为什么需要：
 *   - Kconfig：Shiki 316 种语言里没有 kconfig（只有 kql/kotlin/kusto），
 *     而 ESP-IDF 讲义里有 Kconfig 片段，标 plain/text 会是一片灰。
 *   - math：讲义里有大量 ASCII 公式（v(t) = V0·sin(ωt) 之类），
 *     不是 LaTeX（用 latex 语法几乎高亮不出东西），所以给一套简单的数学版式规则。
 *
 * ⚠️ markdown.languages 是**追加预加载**，不会覆盖默认行为（默认是空数组，
 *    其余语言靠 VitePress 的 loadLanguage() 动态加载），因此改动是纯增量的。
 */
export type LangRegistration = {
  name: string
  scopeName: string
  patterns: { match?: string; include?: string; name?: string }[]
}

/** Kconfig（menuconfig / config / bool / depends on …） */
export const KCONFIG: LangRegistration = {
  name: 'kconfig',
  scopeName: 'source.kconfig',
  patterns: [
    { match: '#.*$', name: 'comment.line.number-sign.kconfig' },
    {
      match: '^\\s*(?:menuconfig|config|menu|choice|endmenu|endchoice|if|endif|source|mainmenu|comment)\\b',
      name: 'keyword.control.kconfig',
    },
    {
      match:
        '\\b(?:bool|tristate|string|int|hex|def_bool|def_tristate|prompt|default|depends|on|select|imply|range|help|visible|optional|modules)\\b',
      name: 'keyword.other.kconfig',
    },
    { match: '"[^"]*"', name: 'string.quoted.double.kconfig' },
    { match: '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?', name: 'variable.other.kconfig' },
    { match: '\\b[yYnNmM]\\b', name: 'constant.language.kconfig' },
  ],
}

/** 工程公式（ASCII 版式）：量纲、函数名、数字、运算符、变量 */
export const MATH: LangRegistration = {
  name: 'math',
  scopeName: 'source.math',
  patterns: [
    { match: '\\b\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?\\b', name: 'constant.numeric.math' },
    {
      match:
        '\\b(?:ns|us|ms|s|Hz|kHz|MHz|GHz|V|mV|A|mA|Ω|kΩ|MΩ|F|H|W|mW|dB|kB|MB|GB|KiB|MiB|bit|byte)\\b',
      name: 'constant.other.unit.math',
    },
    { match: '[µΩ]', name: 'constant.other.unit.math' },
    { match: '\\b(?:sin|cos|tan|log|ln|exp|sqrt|abs|max|min|rms)\\b', name: 'support.function.math' },
    { match: '[=≈≤≥≠∝+\\-*/×÷±⋅√∑∫<>]', name: 'keyword.operator.math' },
    { match: '\\b[A-Z][A-Za-z0-9_]*\\b', name: 'constant.other.math' },
    { match: '\\b[a-z][A-Za-z0-9_]*\\b', name: 'variable.other.math' },
  ],
}

/** Cisco IOS CLI 配置与诊断命令 */
export const IOS: LangRegistration = {
  name: 'ios',
  scopeName: 'source.ios',
  patterns: [
    { match: '^!.*$', name: 'comment.line.exclamation.ios' },
    { match: '#.*$', name: 'comment.line.number-sign.ios' },
    {
      match: '^\\s*(?:[A-Za-z0-9_-]+(?:\\([^)]+\\))?[>#])',
      name: 'entity.name.tag.prompt.ios',
    },
    {
      match:
        '\\b(?:enable|disable|configure|terminal|conf|t|show|sh|interface|int|ip|route|router|ospf|bgp|rip|vlan|switchport|mode|trunk|access|spanning-tree|stp|standby|vrrp|hsrp|crypto|isakmp|ipsec|tunnel|access-list|permit|deny|any|host|line|vty|con|aux|password|secret|username|privilege|service|no|shutdown|shut|exit|end|write|wr|copy|ping|traceroute|debug|undebug|reload)\\b',
      name: 'keyword.control.ios',
    },
    {
      match:
        '\\b(?:FastEthernet|GigabitEthernet|TenGigabitEthernet|Ethernet|Serial|Loopback|Vlan|Port-channel|Fa|Gi|Te|Eth|Se|Lo|Vl|Po)\\s*\\d+(?:/\\d+)*(?:\\.\\d+)?\\b',
      name: 'support.type.interface.ios',
    },
    {
      match: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b',
      name: 'constant.numeric.ip.ios',
    },
    { match: '\\b\\d+\\b', name: 'constant.numeric.ios' },
    { match: '"[^"]*"', name: 'string.quoted.double.ios' },
  ],
}

/** GNU 链接脚本 (Linker Script / ld) */
export const LD: LangRegistration = {
  name: 'ld',
  scopeName: 'source.ld',
  patterns: [
    { match: '/\\*.*?\\*/', name: 'comment.block.ld' },
    { match: '//.*$', name: 'comment.line.ld' },
    { match: '#.*$', name: 'comment.line.ld' },
    {
      match:
        '\\b(?:MEMORY|SECTIONS|ENTRY|OUTPUT_ARCH|OUTPUT_FORMAT|SEARCH_DIR|STARTUP|INPUT|GROUP|INCLUDE|PROVIDE|PROVIDE_HIDDEN|KEEP|ALIGN|AT|SUBALIGN|FILL|ASSERT|ORIGIN|LENGTH|org|len|NOLOAD|DSECT|COPY|INFO|OVERLAY)\\b',
      name: 'keyword.control.ld',
    },
    { match: '\\.[a-zA-Z0-9_.-]+', name: 'entity.name.section.ld' },
    { match: '\\b0x[0-9a-fA-F]+\\b', name: 'constant.numeric.hex.ld' },
    { match: '\\b\\d+[kKmMgG]?[bB]?\\b', name: 'constant.numeric.ld' },
    { match: '[=><+\\-*/&|!~]', name: 'keyword.operator.ld' },
  ],
}

