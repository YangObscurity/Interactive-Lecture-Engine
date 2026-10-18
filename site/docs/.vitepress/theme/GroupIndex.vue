<script setup lang="ts">
/**
 * GroupIndex.vue — 课程组内页（/g01/ /g02/ …）。
 *
 * 结构 = **课程封面卡**（.gi-hero）+ **讲次总表**（.gi-list）。
 * 讲次列表由 themeConfig.groups 自动渲染：**新增一讲不用手改表格**。
 * 组数据按当前路由前缀匹配，所以同一个组件被所有组复用。
 *
 * 集成：
 *   - 每讲行右侧三态打卡状态胶囊（未开始/学习中/已完成），单次点击循环切换；
 *   - 批量标记操作栏（支持全选/多选 -> 一键标记已完成/学习中/未开始）；
 *   - 本地 0ms 优先秒写（neonRepository.ts）+ Notion 知识图谱限流队列异步对齐（notionSync.ts）；
 *   - 纯工程矢量 SVG（icons.ts），严禁 Emoji，SSR 严格安全，零 any。
 *
 * 样式全部在 custom.css 的「课程组内页」段，本文件不写 <style>（分组件约束）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { groupResume } from './reading-progress'
import { ICONS } from './components/ai/icons'
import {
  getAllProgressSync,
  getProgressRecordSync,
  initProgressFromNotionGraph,
  saveLectureProgress,
  batchSaveProgress,
  subscribeProgress,
  type ProgressStatus,
  type ProgressChangeEvent
} from './components/ai/neonRepository'
import { syncStatusToNotion, batchSyncStatusToNotion } from './components/ai/notionSync'
import { showStatusToast } from './components/ai/toast'
import GroupKnowledgeMap from './components/GroupKnowledgeMap.vue'

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
  chartTypes: { mermaid: number; echarts: number; wavedrom: number }
}

interface ThemeConfig {
  groups?: Group[]
}

const { theme } = useData()
const route = useRoute()
const groups = computed<Group[]>(() => {
  const cfg = theme.value as unknown as ThemeConfig
  return cfg.groups || []
})
const group = computed<Group | null>(() => {
  const p = route.path
  return groups.value.find((g) => p.startsWith(`/${g.dir}/`)) || null
})

// 「继续阅读」只存在浏览器本地，必须 mounted 之后读（SSR 没有 localStorage）
const resume = ref<{ path: string; title: string; pct: number } | null>(null)

// 响应式进度状态字典
const progressMap = ref<Record<string, ProgressStatus>>({})
let unsubscribeProgress: (() => void) | null = null

// 批量选择状态
const isBatchMode = ref(false)
const selectedLectures = ref<Set<string>>(new Set())

function getLectureId(dir: string, n: number): string {
  // 键规约铁律：与 neonRepository.normalizeId 完全一致（全小写，含小写 l）
  // 此前大写 -L01 与落库键 -l01 永不匹配，导致讲次总表进度恒 0%
  return `${dir.toLowerCase()}-l${String(n).padStart(2, '0')}`
}

function getStatus(dir: string, n: number): ProgressStatus {
  const id = getLectureId(dir, n)
  return progressMap.value[id] || '未开始'
}

const progressStats = computed(() => {
  if (!group.value) return { completed: 0, total: 0, percent: 0 }
  const dir = group.value.dir
  let completed = 0
  for (const l of group.value.lectures) {
    if (getStatus(dir, l.n) === '已完成') {
      completed++
    }
  }
  const total = group.value.lectures.length
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0
  return { completed, total, percent }
})

const isAllSelected = computed(() => {
  if (!group.value || group.value.lectures.length === 0) return false
  return selectedLectures.value.size === group.value.lectures.length
})

function toggleBatchMode(): void {
  isBatchMode.value = !isBatchMode.value
  if (!isBatchMode.value) {
    selectedLectures.value.clear()
  }
}

function toggleSelectRow(id: string): void {
  if (selectedLectures.value.has(id)) {
    selectedLectures.value.delete(id)
  } else {
    selectedLectures.value.add(id)
  }
}

function toggleSelectAll(): void {
  if (!group.value) return
  if (isAllSelected.value) {
    selectedLectures.value.clear()
  } else {
    const dir = group.value.dir
    selectedLectures.value = new Set(
      group.value.lectures.map((l) => getLectureId(dir, l.n))
    )
  }
}

async function toggleRowStatus(dir: string, n: number): Promise<void> {
  const id = getLectureId(dir, n)
  const current = getStatus(dir, n)
  const next: ProgressStatus = current === '未开始'
    ? '学习中'
    : current === '学习中'
    ? '已完成'
    : '未开始'

  progressMap.value[id] = next
  await saveLectureProgress(id, dir, next)
  const rec = getProgressRecordSync(id)
  syncStatusToNotion(id, next, rec?.notion_node_id || undefined, rec?.notion_page_id || undefined)
  // 屏幕中央快速提示：讲次 · 新状态
  showStatusToast(`${dir.toUpperCase()}-L${String(n).padStart(2, '0')}`, next)
}

async function applyBatchStatus(status: ProgressStatus): Promise<void> {
  if (!group.value || selectedLectures.value.size === 0) return
  const dir = group.value.dir
  const items: Array<{
    lectureId: string
    groupId: string
    status: ProgressStatus
    notionNodeId?: string
    notionPageId?: string
  }> = []

  for (const id of selectedLectures.value) {
    progressMap.value[id] = status
    const rec = getProgressRecordSync(id)
    items.push({
      lectureId: id,
      groupId: dir,
      status,
      notionNodeId: rec?.notion_node_id || undefined,
      notionPageId: rec?.notion_page_id || undefined
    })
  }

  await batchSaveProgress(items)
  batchSyncStatusToNotion(items)
  showStatusToast(`批量 ${selectedLectures.value.size} 讲`, status)
  selectedLectures.value.clear()
  isBatchMode.value = false
}

onMounted(() => {
  const r = group.value ? groupResume(group.value.dir) : null
  if (r) {
    resume.value = {
      path: r.path,
      title: group.value?.lectures.find((l) => l.link === r.path)?.text || r.title,
      pct: r.pct,
    }
  }

  // 键规约铁律：progressMap 键恒为小写，与 normalizeId / getLectureId 全对齐
  const normalizeMap = (m: Record<string, ProgressStatus>): Record<string, ProgressStatus> => {
    const out: Record<string, ProgressStatus> = {}
    for (const [k, v] of Object.entries(m || {})) {
      out[k.toLowerCase()] = v
    }
    return out
  }

  progressMap.value = normalizeMap(getAllProgressSync())
  void initProgressFromNotionGraph()
    .then(() => {
      progressMap.value = normalizeMap(getAllProgressSync())
    })
    .catch(() => {
      // 初始化失败时保持既有本地进度可用，绝不产生 unhandled rejection
    })

  unsubscribeProgress = subscribeProgress((e: ProgressChangeEvent) => {
    if (e.bulk) {
      // Notion 真源批量铺底：整体重读，避免把「无讲次」的哨兵键写进状态字典
      progressMap.value = normalizeMap(getAllProgressSync())
      return
    }
    progressMap.value[e.lectureId.toLowerCase()] = e.status
  })

  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('is-group-page')
  }
})

onUnmounted(() => {
  if (unsubscribeProgress) {
    unsubscribeProgress()
  }
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('is-group-page')
  }
})
</script>

<template>
  <div v-if="group" class="gi" :style="{ '--accent': group.accent }">
    <!-- 课程封面卡：徽章 + 标题 + 摘要 + 元信息 + 标签 + 主按钮行 -->
    <section class="gi-hero">
      <div class="gi-head">
        <span class="gi-badge">{{ group.id }}</span>
        <div class="gi-headtext">
          <h2 class="gi-title">{{ group.title }}</h2>
          <p class="gi-tagline">{{ group.tagline }}</p>
        </div>
      </div>

      <p class="gi-summary">{{ group.summary }}</p>

      <p class="gi-meta">
        <span><b>{{ group.lectureCount }}</b> 讲</span>
        <span v-if="group.chartCount"><b>{{ group.chartCount }}</b> 张可交互图表</span>
        <span v-if="group.chartCount" class="gi-engines">mermaid {{ group.chartTypes.mermaid }} ｜ echarts {{ group.chartTypes.echarts }} ｜ wavedrom {{ group.chartTypes.wavedrom }}</span>
      </p>

      <div class="gi-tags">
        <span v-for="t in group.tags" :key="t" class="gi-tag">{{ t }}</span>
      </div>

      <div class="gi-cta">
        <a class="gi-btn" :href="withBase(group.lectures[0]?.link || '#')">
          <span>开始阅读 · {{ group.lectures[0]?.text || '第 1 讲' }}</span>
          <span class="gi-arrow">→</span>
        </a>
        <a v-if="resume" class="gi-resume" :href="withBase(resume.path)" :title="'继续阅读：' + resume.title">
          <span class="gi-rlabel">继续阅读</span>
          <span class="gi-rname">{{ resume.title }}</span>
          <span class="gi-rbar"><i :style="{ width: Math.round(resume.pct * 100) + '%' }"></i></span>
          <span class="gi-rpct">{{ Math.round(resume.pct * 100) }}%</span>
          <span class="gi-arrow">→</span>
        </a>
      </div>
    </section>

    <!-- 本组动态知识脑图与拓扑结构 (对齐 Notion 知识图谱) -->
    <GroupKnowledgeMap
      :group-id="group.dir"
      :progress-map="progressMap"
    />

    <!-- 讲次总表：章节头 + 统计与批量管理切换 -->
    <div class="gi-sec">
      <div class="gi-sec-left">
        <h3 class="gi-h3">讲次总表</h3>
        <span class="gi-sec-n">共 {{ group.lectureCount }} 讲</span>
        <span class="gi-progress-stat" v-if="progressStats.total > 0">
          已完成 <b>{{ progressStats.completed }}</b>/{{ progressStats.total }} ({{ progressStats.percent }}%)
        </span>
      </div>

      <div class="gi-sec-actions">
        <button
          type="button"
          class="gi-batch-toggle"
          :class="{ active: isBatchMode }"
          @click="toggleBatchMode"
          :title="isBatchMode ? '退出批量标记' : '批量标记讲义状态'"
        >
          <span class="gi-btn-icon" v-html="isBatchMode ? ICONS.close : ICONS.check"></span>
          <span>{{ isBatchMode ? '完成操作' : '批量标记' }}</span>
        </button>
      </div>
    </div>

    <!-- 批量操作栏（批量模式下呈现） -->
    <div v-if="isBatchMode" class="gi-batch-bar">
      <div class="gi-batch-info">
        <button type="button" class="gi-select-all-btn" @click="toggleSelectAll">
          <span class="gi-checkbox-box" :class="{ checked: isAllSelected }">
            <span v-if="isAllSelected" class="gi-check-icon" v-html="ICONS.check"></span>
          </span>
          <span>全选 ({{ selectedLectures.size }}/{{ group.lectureCount }})</span>
        </button>
      </div>

      <div class="gi-batch-ops">
        <button
          type="button"
          class="gi-batch-op completed"
          :disabled="selectedLectures.size === 0"
          @click="applyBatchStatus('已完成')"
          title="将所选项标记为已完成"
        >
          <span class="gi-op-icon" v-html="ICONS.circleCheck"></span>
          <span>标记为已完成</span>
        </button>

        <button
          type="button"
          class="gi-batch-op in-progress"
          :disabled="selectedLectures.size === 0"
          @click="applyBatchStatus('学习中')"
          title="将所选项标记为学习中"
        >
          <span class="gi-op-icon" v-html="ICONS.circleHalf"></span>
          <span>标记为学习中</span>
        </button>

        <button
          type="button"
          class="gi-batch-op not-started"
          :disabled="selectedLectures.size === 0"
          @click="applyBatchStatus('未开始')"
          title="重置所选项为未开始"
        >
          <span class="gi-op-icon" v-html="ICONS.circleDot"></span>
          <span>重置为未开始</span>
        </button>

        <button
          type="button"
          class="gi-batch-op cancel"
          @click="toggleBatchMode"
          title="取消批量管理"
        >
          <span>取消</span>
        </button>
      </div>
    </div>

    <!-- 讲次网格列表 -->
    <ul class="gi-list">
      <li v-for="l in group.lectures" :key="l.n">
        <a
          class="gi-item"
          :href="withBase(l.link)"
          :title="l.text"
          :class="{ 'is-selected': isBatchMode && selectedLectures.has(getLectureId(group.dir, l.n)) }"
          @click="isBatchMode ? ($event.preventDefault(), toggleSelectRow(getLectureId(group.dir, l.n))) : null"
        >
          <!-- 批量选择框 -->
          <span
            v-if="isBatchMode"
            class="gi-row-checkbox"
            :class="{ checked: selectedLectures.has(getLectureId(group.dir, l.n)) }"
            @click.stop.prevent="toggleSelectRow(getLectureId(group.dir, l.n))"
          >
            <span v-if="selectedLectures.has(getLectureId(group.dir, l.n))" class="gi-check-icon" v-html="ICONS.check"></span>
          </span>

          <span class="gi-no">{{ String(l.n).padStart(2, '0') }}</span>
          <span class="gi-t">{{ l.text }}</span>

          <!-- 状态胶囊药丸 (单击循环切换状态) -->
          <button
            type="button"
            class="gi-status-badge"
            :data-status="getStatus(group.dir, l.n)"
            @click.stop.prevent="toggleRowStatus(group.dir, l.n)"
            :title="'当前状态：' + getStatus(group.dir, l.n) + '（点击切换）'"
          >
            <span
              class="gi-status-icon"
              v-html="getStatus(group.dir, l.n) === '已完成' ? ICONS.circleCheck : getStatus(group.dir, l.n) === '学习中' ? ICONS.circleHalf : ICONS.circleDot"
            ></span>
            <span class="gi-status-text">{{ getStatus(group.dir, l.n) }}</span>
          </button>

          <span class="gi-go">→</span>
        </a>
      </li>
    </ul>
  </div>
</template>
