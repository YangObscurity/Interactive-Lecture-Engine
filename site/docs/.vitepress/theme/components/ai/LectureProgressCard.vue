<script setup lang="ts">
/**
 * LectureProgressCard.vue — 讲义文末极简三态完读打卡卡片
 * 
 * 核心契约：
 *   1. 注入讲义正文末尾（位于 ## 下一讲预告 之前，通过 VitePress doc-after 插槽 + DOM 精准锚定）；
 *   2. 三态状态机对齐 Notion「学习节点知识图谱」原生属性：
 *      - 未开始 (Not Started，中性低调灰)
 *      - 学习中 (In Progress，工程琥珀黄)
 *      - 已完成 (Completed，高冷极光绿)
 *   3. 单击无缝轮转状态，或快捷打卡标记完成；
 *   4. 0ms 本地优先秒写（neonRepository.ts），异步平滑限流队列回写 Notion（notionSync.ts）；
 *   5. 铁律：零 Emoji、纯工程矢量 SVG、无多余考题弹窗、SSR 严格安全。
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useData } from 'vitepress'
import { useLectureContext } from './useLectureContext'
import { ICONS } from './icons'
import {
  saveLectureProgress,
  getProgressRecordSync,
  subscribeProgress,
  type ProgressStatus,
  type ProgressChangeEvent
} from './neonRepository'
import { syncStatusToNotion, subscribeNotionSyncState, type SyncState } from './notionSync'
import { showStatusToast } from './toast'

const route = useRoute()
const { frontmatter } = useData()
const { lectureInfo } = useLectureContext()

const isMounted = ref(false)
const targetMount = ref<HTMLElement | null>(null)
const currentStatus = ref<ProgressStatus>('未开始')
const completedAt = ref<string | null>(null)
const syncState = ref<SyncState>('idle')

let unsubscribeProgress: (() => void) | null = null
let unsubscribeNotion: (() => void) | null = null

const isLecture = computed<boolean>(() => {
  return Boolean(lectureInfo.value.lectureId && lectureInfo.value.lectureNum > 0)
})

const notionNodeId = computed<string>(() => {
  const desc = (frontmatter.value?.description as string) || ''
  const m = desc.match(/节点\s*`([^`]+)`/)
  return m ? m[1].trim() : ''
})

const formattedCompletedTime = computed<string>(() => {
  if (!completedAt.value) return ''
  try {
    const d = new Date(completedAt.value)
    if (isNaN(d.getTime())) return ''
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
  } catch {
    return ''
  }
})

function loadCurrentState(): void {
  if (!isLecture.value) return
  const record = getProgressRecordSync(lectureInfo.value.lectureId)
  if (record) {
    currentStatus.value = record.status
    completedAt.value = record.completedAt || null
  } else {
    currentStatus.value = '未开始'
    completedAt.value = null
  }
}

/**
 * 在客户端精确定位 ## 下一讲预告 并在其前置入挂载锚点
 */
function resolveMountAnchor(): void {
  if (typeof document === 'undefined' || !isLecture.value) {
    targetMount.value = null
    return
  }

  const h2Elements = Array.from(document.querySelectorAll<HTMLElement>('.vp-doc h2'))
  const previewH2 = h2Elements.find((el) => {
    const txt = (el.textContent || '').trim()
    return txt.includes('下一讲预告') || el.id.includes('下一讲预告') || el.id.includes('下一讲')
  })

  if (previewH2 && previewH2.parentElement) {
    let mountPoint = document.getElementById('lec-progress-card-mount')
    if (!mountPoint) {
      mountPoint = document.createElement('div')
      mountPoint.id = 'lec-progress-card-mount'
      mountPoint.className = 'lec-progress-mount-slot'
      previewH2.parentElement.insertBefore(mountPoint, previewH2)
    }
    targetMount.value = mountPoint
    return
  }

  targetMount.value = null
}

async function setStatus(newStatus: ProgressStatus): Promise<void> {
  if (!isLecture.value) return

  currentStatus.value = newStatus
  const nowIso = new Date().toISOString()
  completedAt.value = newStatus === '已完成' ? nowIso : null

  // 1. 本地秒存 + 触发全局监听
  await saveLectureProgress(
    lectureInfo.value.lectureId,
    lectureInfo.value.groupDir || lectureInfo.value.groupId,
    newStatus,
    notionNodeId.value
  )

  // 2. 异步限流推送 Notion
  const rec = getProgressRecordSync(lectureInfo.value.lectureId)
  syncStatusToNotion(
    lectureInfo.value.lectureId,
    newStatus,
    notionNodeId.value || rec?.notion_node_id || undefined,
    rec?.notion_page_id || undefined
  )

  // 3. 屏幕中央快速提示
  showStatusToast(lectureInfo.value.lectureId.toUpperCase(), newStatus)
}

function cycleStatus(): void {
  if (currentStatus.value === '未开始') {
    void setStatus('学习中')
  } else if (currentStatus.value === '学习中') {
    void setStatus('已完成')
  } else {
    void setStatus('未开始')
  }
}

function markCompleted(): void {
  void setStatus('已完成')
}

watch(
  () => route.path,
  () => {
    if (isMounted.value) {
      loadCurrentState()
      nextTick(() => {
        resolveMountAnchor()
      })
    }
  }
)

onMounted(() => {
  isMounted.value = true
  loadCurrentState()
  nextTick(() => {
    resolveMountAnchor()
  })

  unsubscribeProgress = subscribeProgress((e: ProgressChangeEvent) => {
    if (e.lectureId === lectureInfo.value.lectureId.toLowerCase()) {
      currentStatus.value = e.status
      if (e.status !== '已完成') {
        completedAt.value = null
      }
    }
  })

  unsubscribeNotion = subscribeNotionSyncState((state) => {
    syncState.value = state
  })
})

onUnmounted(() => {
  if (unsubscribeProgress) unsubscribeProgress()
  if (unsubscribeNotion) unsubscribeNotion()

  if (typeof document !== 'undefined') {
    const el = document.getElementById('lec-progress-card-mount')
    if (el && el.parentElement) {
      el.parentElement.removeChild(el)
    }
  }
})
</script>

<template>
  <div v-if="isMounted && isLecture" class="lec-progress-wrapper">
    <Teleport :to="targetMount" v-if="targetMount">
      <div class="lec-progress-card" :data-status="currentStatus">
        <div class="lpc-main">
          <!-- 状态主识别区 -->
          <div class="lpc-indicator" @click="cycleStatus" role="button" tabindex="0" :title="'当前状态：' + currentStatus + '（点击切换）'">
            <span class="lpc-icon" v-html="currentStatus === '已完成' ? ICONS.circleCheck : currentStatus === '学习中' ? ICONS.circleHalf : ICONS.circleDot"></span>
            <div class="lpc-meta">
              <div class="lpc-status-line">
                <span class="lpc-status-label">{{ currentStatus }}</span>
                <span class="lpc-cycle-hint">点击循环切换</span>
              </div>
              <div class="lpc-sub-line">
                <span class="lpc-id-badge">{{ lectureInfo.lectureId.toUpperCase() }}</span>
                <span v-if="currentStatus === '已完成' && formattedCompletedTime" class="lpc-time-tag">
                  打卡时间 {{ formattedCompletedTime }}
                </span>
                <span v-else-if="currentStatus === '学习中'" class="lpc-time-tag">
                  正在学习本讲
                </span>
                <span v-else class="lpc-time-tag">
                  本讲尚未学习
                </span>
              </div>
            </div>
          </div>

          <!-- 右侧极简三态选择器与打卡快捷按键 -->
          <div class="lpc-actions">
            <!-- 三态分段切换器 -->
            <div class="lpc-segmented">
              <button
                type="button"
                class="lpc-seg-btn"
                :class="{ active: currentStatus === '未开始' }"
                @click="setStatus('未开始')"
                title="标记为未开始"
              >
                <span class="lpc-seg-icon" v-html="ICONS.circleDot"></span>
                <span class="lpc-seg-text">未开始</span>
              </button>
              <button
                type="button"
                class="lpc-seg-btn"
                :class="{ active: currentStatus === '学习中' }"
                @click="setStatus('学习中')"
                title="标记为学习中"
              >
                <span class="lpc-seg-icon" v-html="ICONS.circleHalf"></span>
                <span class="lpc-seg-text">学习中</span>
              </button>
              <button
                type="button"
                class="lpc-seg-btn"
                :class="{ active: currentStatus === '已完成' }"
                @click="setStatus('已完成')"
                title="标记为已完成"
              >
                <span class="lpc-seg-icon" v-html="ICONS.circleCheck"></span>
                <span class="lpc-seg-text">已完成</span>
              </button>
            </div>

            <!-- 主打卡按钮 -->
            <button
              v-if="currentStatus !== '已完成'"
              type="button"
              class="lpc-primary-btn"
              @click="markCompleted"
              title="完成本讲阅读并打卡"
            >
              <span class="lpc-btn-icon" v-html="ICONS.check"></span>
              <span>完读打卡</span>
            </button>
          </div>
        </div>

        <!-- 底部微同步状态栏 -->
        <div class="lpc-footer">
          <div class="lpc-footer-left">
            <span class="lpc-sync-dot" :class="syncState"></span>
            <span v-if="syncState === 'syncing'" class="lpc-footer-hint">正在同步至知识图谱...</span>
            <span v-else class="lpc-footer-hint">Neon PostgreSQL 强持久化 ｜ Notion 知识图谱对齐</span>
          </div>
          <div v-if="notionNodeId" class="lpc-node-ref">
            <code>{{ notionNodeId }}</code>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 兜底备用：若未找到 ## 下一讲预告，直接在 doc-after 原位呈现 -->
    <div v-else class="lec-progress-card" :data-status="currentStatus">
      <div class="lpc-main">
        <div class="lpc-indicator" @click="cycleStatus" role="button" tabindex="0" :title="'当前状态：' + currentStatus + '（点击切换）'">
          <span class="lpc-icon" v-html="currentStatus === '已完成' ? ICONS.circleCheck : currentStatus === '学习中' ? ICONS.circleHalf : ICONS.circleDot"></span>
          <div class="lpc-meta">
            <div class="lpc-status-line">
              <span class="lpc-status-label">{{ currentStatus }}</span>
              <span class="lpc-cycle-hint">点击循环切换</span>
            </div>
            <div class="lpc-sub-line">
              <span class="lpc-id-badge">{{ lectureInfo.lectureId.toUpperCase() }}</span>
              <span v-if="currentStatus === '已完成' && formattedCompletedTime" class="lpc-time-tag">
                打卡时间 {{ formattedCompletedTime }}
              </span>
              <span v-else-if="currentStatus === '学习中'" class="lpc-time-tag">
                正在学习本讲
              </span>
              <span v-else class="lpc-time-tag">
                本讲尚未学习
              </span>
            </div>
          </div>
        </div>

        <div class="lpc-actions">
          <div class="lpc-segmented">
            <button
              type="button"
              class="lpc-seg-btn"
              :class="{ active: currentStatus === '未开始' }"
              @click="setStatus('未开始')"
            >
              <span class="lpc-seg-icon" v-html="ICONS.circleDot"></span>
              <span class="lpc-seg-text">未开始</span>
            </button>
            <button
              type="button"
              class="lpc-seg-btn"
              :class="{ active: currentStatus === '学习中' }"
              @click="setStatus('学习中')"
            >
              <span class="lpc-seg-icon" v-html="ICONS.circleHalf"></span>
              <span class="lpc-seg-text">学习中</span>
            </button>
            <button
              type="button"
              class="lpc-seg-btn"
              :class="{ active: currentStatus === '已完成' }"
              @click="setStatus('已完成')"
            >
              <span class="lpc-seg-icon" v-html="ICONS.circleCheck"></span>
              <span class="lpc-seg-text">已完成</span>
            </button>
          </div>

          <button
            v-if="currentStatus !== '已完成'"
            type="button"
            class="lpc-primary-btn"
            @click="markCompleted"
          >
            <span class="lpc-btn-icon" v-html="ICONS.check"></span>
            <span>完读打卡</span>
          </button>
        </div>
      </div>

      <div class="lpc-footer">
        <div class="lpc-footer-left">
          <span class="lpc-sync-dot" :class="syncState"></span>
          <span v-if="syncState === 'syncing'" class="lpc-footer-hint">正在同步至知识图谱...</span>
          <span v-else class="lpc-footer-hint">Neon PostgreSQL 强持久化 ｜ Notion 知识图谱对齐</span>
        </div>
        <div v-if="notionNodeId" class="lpc-node-ref">
          <code>{{ notionNodeId }}</code>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lec-progress-mount-slot {
  margin: 36px 0 24px 0;
  display: block;
  width: 100%;
}

.lec-progress-card {
  margin: 28px 0;
  padding: 16px 20px;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  transition: all 0.25s ease;
}

/* 三态边框与高亮微光 */
.lec-progress-card[data-status="未开始"] {
  border-color: var(--vp-c-divider);
}

.lec-progress-card[data-status="学习中"] {
  border-color: rgba(245, 158, 11, 0.4);
  background: linear-gradient(to right, rgba(245, 158, 11, 0.04), var(--vp-c-bg-soft));
}

.lec-progress-card[data-status="已完成"] {
  border-color: rgba(16, 185, 129, 0.45);
  background: linear-gradient(to right, rgba(16, 185, 129, 0.05), var(--vp-c-bg-soft));
}

.lpc-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.lpc-indicator {
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  user-select: none;
  padding: 4px 6px;
  border-radius: 8px;
  transition: background-color 0.15s ease;
}

.lpc-indicator:hover {
  background: var(--vp-c-bg-mute);
}

.lpc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.lec-progress-card[data-status="未开始"] .lpc-icon {
  color: var(--vp-c-text-3);
  border-color: var(--vp-c-divider);
}

.lec-progress-card[data-status="学习中"] .lpc-icon {
  color: #f59e0b;
  border-color: #f59e0b;
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.25);
}

.lec-progress-card[data-status="已完成"] .lpc-icon {
  color: #10b981;
  border-color: #10b981;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.25);
}

.lpc-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lpc-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lpc-status-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.lpc-cycle-hint {
  font-size: 11px;
  color: var(--vp-c-text-3);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}

.lpc-sub-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.lpc-id-badge {
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--vp-c-text-2);
}

.lpc-time-tag {
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-3);
}

.lpc-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 分段切换按钮组 */
.lpc-segmented {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  gap: 2px;
}

.lpc-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.lpc-seg-btn:hover {
  color: var(--vp-c-text-1);
}

.lpc-seg-btn.active {
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-1);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.lpc-seg-icon {
  display: inline-flex;
  align-items: center;
}

.lpc-primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.lpc-primary-btn:hover {
  background: #10b981;
  color: #ffffff;
  border-color: #10b981;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
}

.lpc-btn-icon {
  display: inline-flex;
  align-items: center;
}

.lpc-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--vp-c-divider);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}

.lpc-footer-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lpc-sync-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vp-c-text-3);
}

.lpc-sync-dot.syncing {
  background: #3b82f6;
  box-shadow: 0 0 6px #3b82f6;
  animation: pulse-dot 1.2s infinite ease-in-out;
}

.lpc-sync-dot.error {
  background: #ef4444;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.lpc-node-ref code {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  border: 1px solid var(--vp-c-divider);
}

@media (max-width: 640px) {
  .lpc-main {
    flex-direction: column;
    align-items: stretch;
  }
  .lpc-actions {
    justify-content: space-between;
  }
  .lpc-footer {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
