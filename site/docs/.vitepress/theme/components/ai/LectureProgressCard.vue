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
 *   4. 进度走 useProgress()（theme/progress：乐观更新 + 待发队列 + 重试），Notion 对齐由 notionBridge 负责；
 *   5. 铁律：零 Emoji、纯工程矢量 SVG、无多余考题弹窗、SSR 严格安全。
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useData } from 'vitepress'
import { useLectureContext } from './useLectureContext'
import { ICONS } from './icons'
import { useSession } from '../../auth/useSession'
import { useProgress } from '../../progress/useProgress'
import { toLegacyStatus } from '../../progress/types'
import type { ProgressStatus } from '../../progress/types'
import {
  getLastNotionSyncError,
  retryFailedNotionSync,
  subscribeNotionSyncState,
  type SyncState,
} from './notionSync'
import { showMessageToast, showStatusToast } from './toast'
import { useT } from '../../../i18n/useT.ts'

const route = useRoute()
const { frontmatter, theme } = useData()
const { lectureInfo } = useLectureContext()

const { t } = useT()
const session = useSession()
const progress = useProgress()
progress.onRejected(({ id }) => {
  if (!isLecture.value) return
  showMessageToast(t('progress.rejected', { id: id.toUpperCase() }))
})

const isMounted = ref(false)
const targetMount = ref<HTMLElement | null>(null)
const syncState = ref<SyncState>('idle')
const syncErrorDetail = ref<string | null>(null)

let unsubscribeNotion: (() => void) | null = null

const isLecture = computed<boolean>(() => {
  return Boolean(lectureInfo.value.lectureId && lectureInfo.value.lectureNum > 0)
})

// Read the (reactive, build-time) site config, not progressRuntime(): that is configured after hydration, so a
// computed that already ran with a fast session answer would never see the flag flip and the control would stay hidden.
const isTempGroup = computed<boolean>(() => lectureInfo.value.isTemp)

const notionSyncConfigured = computed<boolean>(
  () =>
    (theme.value as { lectureModules?: { progress?: { notionSync?: unknown } } } | undefined)?.lectureModules?.progress
      ?.notionSync === true
)

const progressAdapter = computed<'local' | 'rest'>(() =>
  (theme.value as { lectureModules?: { progress?: { adapter?: unknown } } } | undefined)?.lectureModules?.progress
    ?.adapter === 'rest'
    ? 'rest'
    : 'local'
)

const showNotionSync = computed<boolean>(() => {
  return Boolean(
    !isTempGroup.value &&
      notionSyncConfigured.value &&
      session.value.status === 'authenticated' &&
      session.value.roles.includes('admin')
  )
})

const showTempProgress = computed<boolean>(() => Boolean(isLecture.value && isTempGroup.value))

const notionNodeId = computed<string>(() => {
  const desc = (frontmatter.value?.description as string) || ''
  const m = desc.match(/\u8282\u70b9\s*`([^`]+)`/) || desc.match(/\bnode\s*`([^`]+)`/i)
  return m?.[1] ? m[1].trim() : ''
})

/** Domain status; stays not_started until client hydration completes. */
const status = computed<ProgressStatus>(() =>
  isLecture.value ? progress.statusOf(lectureInfo.value.lectureId) : 'not_started'
)
/** Legacy attribute value retained for existing progress tests. */
const currentStatus = computed(() => toLegacyStatus(status.value))
const statusLabel = computed<string>(() => {
  if (status.value === 'completed') return t('ai.lpcStatusCompleted')
  if (status.value === 'in_progress') return t('ai.lpcStatusInProgress')
  return t('ai.lpcStatusNotStarted')
})
const statusIcon = computed<string>(() => {
  if (status.value === 'completed') return ICONS.circleCheck
  if (status.value === 'in_progress') return ICONS.circleHalf
  return ICONS.circleDot
})
const syncStatusIcon = computed<string>(() => {
  if (syncState.value === 'error') return ICONS.statusUnavailable
  if (syncState.value === 'idle') return ICONS.statusOk
  return ICONS.statusRateLimited
})
const completedAt = computed<string | null>(() =>
  isLecture.value ? progress.completedAtOf(lectureInfo.value.lectureId) : null
)

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

function resolveMountAnchor(): void {
  if (typeof document === 'undefined' || !isLecture.value) {
    targetMount.value = null
    return
  }

  const h2Elements = Array.from(document.querySelectorAll<HTMLElement>('.vp-doc h2'))
  const previewH2 = h2Elements.find((el) => {
    const txt = (el.textContent || '').trim()
    return (
      txt.includes('\u4e0b\u4e00\u8bb2\u9884\u544a') ||
      el.id.includes('\u4e0b\u4e00\u8bb2\u9884\u544a') ||
      el.id.includes('\u4e0b\u4e00\u8bb2') ||
      /next lecture|preview/i.test(txt)
    )
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

function setStatus(newStatus: ProgressStatus): void {
  if (!isLecture.value) return
  const info = lectureInfo.value
  progress.set(info.lectureId, newStatus, { groupId: info.groupDir || info.groupId })
  showStatusToast(info.lectureId.toUpperCase(), toLegacyStatus(newStatus))
}

function cycleStatus(): void {
  if (status.value === 'not_started') setStatus('in_progress')
  else if (status.value === 'in_progress') setStatus('completed')
  else setStatus('not_started')
}

function markCompleted(): void {
  setStatus('completed')
}

function handleRetrySync(): void {
  retryFailedNotionSync()
}

watch(
  () => route.path,
  () => {
    if (isMounted.value) {
      nextTick(() => {
        resolveMountAnchor()
      })
    }
  }
)

onMounted(() => {
  isMounted.value = true
  nextTick(() => {
    resolveMountAnchor()
  })

  unsubscribeNotion = subscribeNotionSyncState((state) => {
    syncState.value = state
    syncErrorDetail.value = getLastNotionSyncError()
  })
})

onUnmounted(() => {
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
    <Teleport :to="targetMount || 'body'" :disabled="!targetMount">
      <div class="lec-progress-card" :data-status="currentStatus" :data-state="status">
        <div class="lpc-main">
          <div
            class="lpc-indicator"
            role="button"
            tabindex="0"
            :title="t('ai.lpcStatusTitle', { status: statusLabel })"
            @click="cycleStatus"
            @keydown.enter.prevent="cycleStatus"
            @keydown.space.prevent="cycleStatus"
          >
            <span class="lpc-icon" v-html="statusIcon"></span>
            <div class="lpc-meta">
              <div class="lpc-status-line">
                <span class="lpc-status-label">{{ statusLabel }}</span>
                <span class="lpc-cycle-hint">{{ t('ai.lpcCycleHint') }}</span>
              </div>
              <div class="lpc-sub-line">
                <span class="lpc-id-badge">{{ lectureInfo.lectureId.toUpperCase() }}</span>
                <span v-if="isTempGroup" class="lpc-temp-badge" data-lpc-temp-badge>{{ t('ai.tempGroupBadge') }}</span>
                <span v-if="status === 'completed' && formattedCompletedTime" class="lpc-time-tag">
                  {{ t('ai.lpcCompletedAt', { time: formattedCompletedTime }) }}
                </span>
                <span v-else-if="status === 'in_progress'" class="lpc-time-tag">
                  {{ t('ai.lpcInProgress') }}
                </span>
                <span v-else class="lpc-time-tag">
                  {{ t('ai.lpcNotStarted') }}
                </span>
              </div>
            </div>
          </div>

          <div class="lpc-actions">
            <div class="lpc-segmented">
              <button
                type="button"
                class="lpc-seg-btn"
                :class="{ active: status === 'not_started' }"
                :title="t('ai.lpcMarkNotStartedTitle')"
                @click="setStatus('not_started')"
              >
                <span class="lpc-seg-icon" v-html="ICONS.circleDot"></span>
                <span class="lpc-seg-text">{{ t('ai.lpcStatusNotStarted') }}</span>
              </button>
              <button
                type="button"
                class="lpc-seg-btn"
                :class="{ active: status === 'in_progress' }"
                :title="t('ai.lpcMarkInProgressTitle')"
                @click="setStatus('in_progress')"
              >
                <span class="lpc-seg-icon" v-html="ICONS.circleHalf"></span>
                <span class="lpc-seg-text">{{ t('ai.lpcStatusInProgress') }}</span>
              </button>
              <button
                type="button"
                class="lpc-seg-btn"
                :class="{ active: status === 'completed' }"
                :title="t('ai.lpcMarkCompletedTitle')"
                @click="setStatus('completed')"
              >
                <span class="lpc-seg-icon" v-html="ICONS.circleCheck"></span>
                <span class="lpc-seg-text">{{ t('ai.lpcStatusCompleted') }}</span>
              </button>
            </div>

            <button
              v-if="status !== 'completed'"
              type="button"
              class="lpc-primary-btn"
              :title="t('ai.lpcCompleteBtnTitle')"
              @click="markCompleted"
            >
              <span class="lpc-btn-icon" v-html="ICONS.check"></span>
              <span>{{ t('ai.lpcCompleteBtnLabel') }}</span>
            </button>
          </div>
        </div>

        <!-- Admin-only Notion sync control & honest failure status (D-11) -->
        <div v-if="showNotionSync" class="lpc-footer" data-lpc-notion-control>
          <div class="lpc-footer-left">
            <span class="lpc-sync-glyph" :class="syncState" aria-hidden="true" v-html="syncStatusIcon"></span>
            <span v-if="syncState === 'error'" class="lpc-footer-hint is-error" data-lpc-notion-error>
              {{ t('ai.notionSyncFailed', { detail: syncErrorDetail || t('ai.networkError') }) }}
            </span>
            <span v-else-if="syncState !== 'idle'" class="lpc-footer-hint">
              {{ t('ai.notionSyncSyncing') }}
            </span>
            <span v-else class="lpc-footer-hint">
              {{ t('ai.notionSyncIdle') }}
            </span>
            <button
              v-if="syncState === 'error'"
              type="button"
              class="lpc-retry-btn"
              data-lpc-notion-retry
              @click="handleRetrySync"
            >
              {{ t('ai.notionSyncRetry') }}
            </button>
          </div>
          <div v-if="notionNodeId" class="lpc-node-ref">
            <code>{{ notionNodeId }}</code>
          </div>
        </div>
        <div v-else-if="showTempProgress" class="lpc-footer lpc-footer-temp" data-lpc-temp-progress>
          <div class="lpc-footer-left">
            <span class="lpc-temp-dot" aria-hidden="true"></span>
            <span class="lpc-footer-hint">
              {{ progressAdapter === 'rest' ? t('ai.tempGroupDbOnly') : t('ai.tempGroupLocalOnly') }}
            </span>
          </div>
        </div>
      </div>
    </Teleport>
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
  border-radius: var(--lec-radius-2);
  border: 1px solid var(--lec-border);
  background: var(--lec-surface);
  transition: all 0.25s ease;
}

.lec-progress-card[data-state="not_started"] {
  border-color: var(--lec-border);
}

.lec-progress-card[data-state="in_progress"] {
  border-color: var(--lec-warning);
  background: var(--lec-warning-tint);
}

.lec-progress-card[data-state="completed"] {
  border-color: var(--lec-done);
  background: var(--lec-bg);
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
  border-radius: var(--lec-radius-1);
  transition: background-color 0.15s ease;
}

.lpc-indicator:hover {
  background: var(--lec-bg);
}

.lpc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.lec-progress-card[data-state="not_started"] .lpc-icon {
  color: var(--lec-text-muted);
  border-color: var(--lec-border);
}

.lec-progress-card[data-state="in_progress"] .lpc-icon {
  color: var(--lec-warning);
  border-color: var(--lec-warning);
}

.lec-progress-card[data-state="completed"] .lpc-icon {
  color: var(--lec-done-text);
  border-color: var(--lec-done);
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
  color: var(--lec-text);
}

.lpc-cycle-hint {
  font-size: 11px;
  color: var(--lec-text-muted);
  padding: 1px 6px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
}

.lpc-sub-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--lec-text-muted);
}

.lpc-id-badge {
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--lec-text-muted);
}

.lpc-temp-badge {
  font-size: 11px;
  line-height: 1.45;
  padding: 0 6px;
  border-radius: var(--lec-radius-1);
  border: 1px dashed var(--lec-border);
  background: var(--lec-bg);
  color: var(--lec-text-muted);
  white-space: nowrap;
}

.lpc-time-tag {
  font-variant-numeric: tabular-nums;
  color: var(--lec-text-muted);
}

.lpc-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lpc-segmented {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  gap: 2px;
}

.lpc-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--lec-radius-1);
  border: none;
  background: transparent;
  color: var(--lec-text-muted);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.lpc-seg-btn:hover {
  color: var(--lec-text);
}

.lpc-seg-btn.active {
  background: var(--lec-accent-tint);
  color: var(--lec-accent);
  font-weight: 600;
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
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-done);
  background: var(--lec-bg);
  color: var(--lec-done-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.lpc-primary-btn:hover {
  background: var(--lec-accent);
  color: var(--lec-on-accent);
  border-color: var(--lec-accent);
}

.lpc-btn-icon {
  display: inline-flex;
  align-items: center;
}

.lpc-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--lec-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  color: var(--lec-text-muted);
}

.lpc-footer-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lpc-sync-glyph {
  display: inline-flex;
  align-items: center;
  color: var(--lec-done-text);
}

.lpc-temp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--lec-text-muted);
  flex: none;
}

.lpc-sync-glyph.syncing,
.lpc-sync-glyph.throttling,
.lpc-sync-glyph.retrying {
  color: var(--lec-accent);
}

.lpc-sync-glyph.error {
  color: var(--lec-danger);
}

.lpc-footer-hint.is-error {
  color: var(--lec-danger);
}

.lpc-retry-btn {
  border: 1px solid var(--lec-danger);
  background: var(--lec-danger-tint);
  color: var(--lec-danger);
  border-radius: var(--lec-radius-1);
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}

.lpc-node-ref code {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text-muted);
  border: 1px solid var(--lec-border);
}

@media (max-width: 640px) {
  .lpc-main {
    flex-direction: column;
    align-items: stretch;
  }
  /* the segmented control plus the primary button are wider than a phone in English: let the button drop below */
  .lpc-indicator,
  .lpc-actions {
    min-width: 0;
  }
  .lpc-actions {
    justify-content: space-between;
    flex-wrap: wrap;
    row-gap: 8px;
  }
  .lpc-footer {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
