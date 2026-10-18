<script setup lang="ts">
/**
 * HomeBody.vue — 站点首页核心门户与全景演进枢纽（Hero & Map Hub）。
 *
 * 架构设计原则：
 * 1. 以「全站知识演进脑图」为全站认知与视觉基准（Hero Anchor）；
 * 2. 顶栏收敛整合全站愿景、核心指标（课程组、讲义数、交互图表、知识节点状态同步）与启航指引；
 * 3. 黄金版心：1320px 宽屏视野，两侧留白匀称；
 * 4. 严守 SSR 安全铁律与客户端数据真源（themeConfig.groups + 目录扫描 + notion_knowledge_graph.json）；
 * 5. 下游优雅流转：动态衔接「继续阅读」、「课程组导航卡片矩阵」、「图表引擎与核心能力」与「工程阅读指南」。
 */
import { computed, onMounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import { recentReads } from './reading-progress'
import { initProgressFromNotionGraph } from './components/ai/neonRepository'
import GlobalCurriculumMap from './components/GlobalCurriculumMap.vue'

type Lecture = { n: number; text: string; link: string }
type Group = {
  id: string
  dir: string
  title: string
  tagline: string
  summary: string
  accent: string
  tags: string[]
  lectures: Lecture[]
  lectureCount: number
  chartCount: number
  temp?: boolean
}

type Recent = { path: string; title: string; group: string; pct: number; ts: number }

const { theme } = useData()
const siteMeta = computed(() => (theme.value as any).siteMeta || {})
const groups = computed<Group[]>(() => ((theme.value as any).groups as Group[]) || [])
const totals = computed(() => ((theme.value as any).totals as { lectures: number; charts: number }) || {
  lectures: groups.value.reduce((acc, g) => acc + (g.lectureCount || g.lectures?.length || 0), 0),
  charts: groups.value.reduce((acc, g) => acc + (g.chartCount || 0), 0)
})
const features = computed(() => ((theme.value as any).siteFeatures as { title: string; details: string }[]) || [])

// 动态派生顶栏品牌文案（单一真源来自 siteMeta，无私有硬编码）
const heroPillText = computed(() => siteMeta.value.name ? `${siteMeta.value.name} · 全景演进架构` : '可交互工程讲义库 · 全景演进架构')
const heroTitle = computed(() => siteMeta.value.text || '可交互工程讲义库')
const heroTagline = computed(() => siteMeta.value.tagline || '把一门课写成一站式可交互讲义 —— 图表原生可交互、公式构建期渲染、内容与引擎彻底解耦')

// 启航按钮
const firstGroupLink = computed(() => groups.value.length > 0 ? withBase(`/${groups.value[0].dir}/`) : withBase('/examples/g01/'))
const firstGroupTitle = computed(() => groups.value.length > 0 ? `从 ${groups.value[0].id} ${groups.value[0].title} 启航` : '从基础示例启航')
const groupsRangeLabel = computed(() => {
  if (groups.value.length === 0) return '模块化大系'
  if (groups.value.length === 1) return groups.value[0].id
  return `${groups.value[0].id} ~ ${groups.value[groups.value.length - 1].id}`
})

// 知识图谱节点状态同步统计（动态读取知识图谱，无硬编码）
const notionNodeTotal = ref(0)

// 「继续阅读」只存在于浏览器本地，必须在 mounted 之后读（SSR 阶段没有 localStorage）
const recent = ref<Recent[]>([])
onMounted(async () => {
  recent.value = recentReads(6)
  void initProgressFromNotionGraph()
  try {
    const res = await fetch(withBase('/notion_knowledge_graph.json'))
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) {
        notionNodeTotal.value = data.length
      }
    }
  } catch {}
})
</script>

<template>
  <div class="home-body">
    <!-- 首页顶部全景视效与愿景核心 (Hero Hub Header) -->
    <header class="hb-hero-hub">
      <div class="hub-pill">
        <span class="hub-pulse"></span>
        <span class="hub-pill-text">{{ heroPillText }}</span>
      </div>

      <h1 class="hub-title">
        {{ heroTitle }}
      </h1>

      <p class="hub-tagline">
        {{ heroTagline }}
      </p>

      <!-- 核心指标徽标组 (Compact Metrics Strip) -->
      <div class="hub-stats-strip">
        <div class="stat-item">
          <span class="stat-num">{{ groups.length }}</span>
          <span class="stat-label">课程体系</span>
        </div>
        <span class="stat-divider">·</span>
        <div class="stat-item">
          <span class="stat-num">{{ totals.lectures }}</span>
          <span class="stat-label">核心讲次</span>
        </div>
        <span class="stat-divider">·</span>
        <div class="stat-item">
          <span class="stat-num">{{ totals.charts }}</span>
          <span class="stat-label">交互图表</span>
        </div>
        <template v-if="notionNodeTotal > 0">
          <span class="stat-divider">·</span>
          <div class="stat-item">
            <span class="stat-num">{{ notionNodeTotal }}</span>
            <span class="stat-label">知识节点</span>
          </div>
        </template>
        <span class="stat-divider">·</span>
        <div class="stat-item feature">
          <span class="stat-tag">纯矢量 SVG · KaTeX · 物理解耦</span>
        </div>
      </div>
    </header>

    <!-- 全站大系全景动态知识脑图 (对齐 Notion 知识图谱 · 首页核心视觉锚点) -->
    <GlobalCurriculumMap />

    <!-- 继续阅读模块 -->
    <section v-if="recent.length" class="hb-section">
      <div class="hb-section-header">
        <h2 class="hb-h2">继续阅读</h2>
        <span class="hb-section-subtitle">基于浏览器本地进度的快速续读通道</span>
      </div>
      <div class="hb-recent">
        <a v-for="r in recent" :key="r.path" class="hb-rc" :href="withBase(r.path)">
          <span class="hb-rc-g">{{ r.group.toUpperCase() }}</span>
          <span class="hb-rc-t">{{ r.title }}</span>
          <span class="hb-rc-bar"><i :style="{ width: Math.round(r.pct * 100) + '%' }"></i></span>
          <span class="hb-rc-n">{{ Math.round(r.pct * 100) }}%</span>
        </a>
      </div>
    </section>

    <!-- 课程组导航矩阵 -->
    <section id="groups" class="hb-section">
      <div class="hb-section-header">
        <h2 class="hb-h2">课程组全景矩阵</h2>
        <span class="hb-section-subtitle">按工程认知进阶划分的 13 门纵深体系</span>
      </div>
      <div class="hb-grid">
        <a
          v-for="g in groups"
          :key="g.id"
          class="hb-card"
          :href="withBase(`/${g.dir}/`)"
          :style="{ '--accent': g.accent }"
        >
          <div class="hb-card-top">
            <span class="hb-badge">{{ g.id }}</span>
            <span v-if="g.temp" class="hb-temp">临时</span>
            <span class="hb-count">{{ g.lectureCount }} 讲<span v-if="g.chartCount"> · {{ g.chartCount }} 图</span></span>
          </div>
          <h3 class="hb-title">{{ g.title }}</h3>
          <p class="hb-tagline">{{ g.tagline }}</p>
          <p class="hb-summary">{{ g.summary }}</p>
          <div class="hb-tags">
            <span v-for="t in g.tags" :key="t" class="hb-tag">{{ t }}</span>
          </div>
          <div class="hb-enter">
            <span class="hb-arrow">→</span>
            <span>进入课程</span>
            <span class="hb-first">{{ g.lectures[0]?.text || '第 1 讲' }}</span>
          </div>
        </a>
      </div>
    </section>

    <!-- 讲义核心能力与图表引擎 -->
    <section class="hb-section">
      <div class="hb-section-header">
        <h2 class="hb-h2">讲义工程特性与交互引擎</h2>
        <span class="hb-section-subtitle">为硬件与软件工程师打造的原生沉浸式体验</span>
      </div>
      <div class="hb-feats">
        <div v-for="f in features" :key="f.title" class="hb-feat">
          <h3>{{ f.title }}</h3>
          <p>{{ f.details }}</p>
        </div>
      </div>
    </section>

    <!-- 阅读指南 -->
    <section class="hb-section">
      <div class="hb-section-header">
        <h2 class="hb-h2">工程阅读与交互指南</h2>
        <span class="hb-section-subtitle">掌握本站富媒体与图表仿真的交互操作</span>
      </div>
      <ul class="hb-tips">
        <li><b>全局演进脑图</b>：双翼放射式拓扑布局，支持按需展开/折叠各体系分支，点击任一讲次叶子直接跃迁正文。</li>
        <li><b>沉浸式阅读</b>：正文右上角点击 <b>沉浸阅读</b> 收起侧边栏与大纲，开启宽版心无干扰长文专注文档模式。</li>
        <li><b>全景图表交互</b>：任意图表点击右上角 <b>↗</b> 进入全屏独立沙盒：<b>＋ / −</b> 无级缩放、<b>↺</b> 视口复位、<b>Esc</b> 一键退出。</li>
        <li><b>动态参数仿真</b>：ECharts 物理特性图支持鼠标悬停探针、图例开闭、时间序列平移；底部「图表源码」可展开原始工程配置。</li>
        <li><b>标准公式即刻复制</b>：KaTeX 渲染公式原生遵循 SI 单位与分式契约，点击任意数学公式即可复制标准 LaTeX 源码。</li>
      </ul>
    </section>
  </div>
</template>
