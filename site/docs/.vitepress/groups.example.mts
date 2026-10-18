/**
 * groups.example.mts — 现代系统架构与软件工程演示课程体系 (6 课程大系 / 12 核心讲次 / 20 交互图表)
 */

export type GroupMeta = {
  id: string
  dir: string
  title: string
  tagline: string
  summary: string
  accent: string
  tags: string[]
  temp?: boolean
}

export const SITE_META = {
  name: '现代系统架构与工程体系',
  text: '可交互工程讲义引擎 · 演示系统',
  tagline: '从底层微架构、现代语言运行时与网络协议，到分布式共识、高性能存储与云原生可观测性 —— 原生可交互式知识演进网络',
} as const

export const SITE_FEATURES: { title: string; details: string }[] = [
  {
    title: '图表原生可交互',
    details: '内联视图只看不操作：点一下图表即进入全屏放大，无缝自适应整幅；缩放与拖动在全屏层进行。ECharts 悬停看数值、点图例开关数据线，WaveDrom 时钟沿对齐。',
  },
  {
    title: '沉浸式阅读',
    details: '一键收起导航与大纲，版心放宽、行距上调；状态本地记忆，跨页面自动保持。',
  },
  {
    title: '构建期 KaTeX 公式',
    details: 'LaTeX 在构建期由 KaTeX 渲染成 HTML，首屏零闪烁；点击公式直接复制 TeX 源码。',
  },
  {
    title: '出版级打印导出',
    details: '右上角常驻导出浮层，支持 A4 跨页防截断多页 PDF 与超长全景 Canvas 切片导出。',
  },
  {
    title: '内容与引擎物理解耦',
    details: '引擎只带结构，讲义放置于独立内容源按需挂载；同一套引擎承载任意学科，私有数据绝不入库。',
  },
]

export const GROUPS: GroupMeta[] = [
  {
    id: 'G01',
    dir: 'examples/g01',
    title: '计算机组成与系统底层',
    tagline: 'CPU 微架构、缓存层次与内存屏障',
    summary: '从物理门电路与时序逻辑，深入现代多核处理器缓存一致性（MESI）、虚拟内存多级页表推演与分支预测器工作机制，建立软硬件协同的底层系统心智模型。',
    accent: '#2563EB',
    tags: ["计算机组成", "CPU微架构", "MESI协议", "虚拟内存"],
  },
  {
    id: 'G02',
    dir: 'examples/g02',
    title: '现代语言运行时与并发工程',
    tagline: '协程调度、垃圾回收与内存模型',
    summary: '剖析现代高性能系统语言运行时的内部机理，涵盖 M:N 协程调度器（Work-Stealing）、分代并发垃圾回收（三色标记法）以及内存屏障与无锁数据结构。',
    accent: '#7C3AED',
    tags: ["语言运行时", "GMP调度", "并发编程", "三色标记GC"],
  },
  {
    id: 'G03',
    dir: 'examples/g03',
    title: '高性能网络与传输协议',
    tagline: '传输层演进、QUIC 协议与拥塞控制',
    summary: '从经典 TCP 三次握手与四次挥手状态机出发，深入现代基于 UDP 的 QUIC 单往返建连、连接迁移特性，并对 BBR 与 CUBIC 拥塞控制算法展开数学建模与吞吐推演。',
    accent: '#059669',
    tags: ["网络协议栈", "QUIC协议", "BBR算法", "全双工通信"],
  },
  {
    id: 'G04',
    dir: 'examples/g04',
    title: '分布式共识与容错架构',
    tagline: 'Raft 状态机、分布式事务与租约机制',
    summary: '系统探讨在不可靠网络环境下实现强一致性共识的核心算法：Raft 领导者选举与日志复制、分布式两阶段提交（2PC/3PC）以及分布式锁与租约安全保证。',
    accent: '#D97706',
    tags: ["分布式系统", "Raft共识", "CAP定理", "两阶段提交"],
  },
  {
    id: 'G05',
    dir: 'examples/g05',
    title: '高性能存储引擎与索引结构',
    tagline: 'LSM 树、B+ 树与分层存储架构',
    summary: '对比现代主流存储引擎的底层索引结构：面向写优化的 LSM 树（MemTable/SSTable 压缩与布隆过滤器）与面向读优化的 B+ 树并发分裂控制，量化分析写放大与读放大权衡。',
    accent: '#DC2626',
    tags: ["存储引擎", "LSM-Tree", "B+树", "写放大分析"],
  },
  {
    id: 'G06',
    dir: 'examples/g06',
    title: '云原生网格与全链路可观测性',
    tagline: 'eBPF 内核探测、服务网格与可观测性',
    summary: '探索现代云原生基础设施观测底座：利用 eBPF 技术在 Linux 内核层实现无侵入性能剖析，结合 W3C TraceContext 与 OpenTelemetry 规范构建微服务分布式追踪链路。',
    accent: '#0891B2',
    tags: ["云原生", "eBPF", "服务网格", "分布式追踪"],
  },
]

export const GROUP_META: GroupMeta[] = GROUPS
