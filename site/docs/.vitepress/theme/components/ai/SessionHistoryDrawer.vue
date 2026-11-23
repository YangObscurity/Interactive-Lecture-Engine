<template>
  <Transition name="drawer-slide">
    <div
      v-if="isOpen"
      ref="drawerRef"
      class="session-history-drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="t('ai.drawerAria')"
    >
      <!-- 抽屉顶栏 -->
      <header class="drawer-header">
        <div class="header-left">
          <span class="header-icon" v-html="ICONS.history"></span>
          <h3 class="header-title">{{ t('ai.drawerTitle') }}</h3>
          <span v-if="lectureBadge" class="lecture-badge">{{ lectureBadge }}</span>
        </div>
        <button
          ref="closeBtnRef"
          type="button"
          class="header-close-btn"
          :title="t('ai.drawerClose')"
          :aria-label="t('ai.drawerClose')"
          @click="handleClose"
        >
          <span class="btn-icon" v-html="ICONS.close"></span>
        </button>
      </header>

      <!-- 操作工具栏：新建与清空 -->
      <section class="drawer-actions">
        <button
          type="button"
          class="action-btn action-create"
          :title="currentLectureId ? t('ai.newLectureSessionTitle') : t('ai.newSession')"
          :disabled="isLoading"
          @click="handleCreateSession"
        >
          <span class="btn-icon" v-html="ICONS.plus"></span>
          <span class="btn-text">{{ t('ai.newSession') }}</span>
        </button>

        <button
          type="button"
          class="action-btn action-clear"
          :class="{ 'is-confirming': isConfirmingClear }"
          :disabled="isLoading || (currentLectureId ? sessions.length === 0 : allSessions.length === 0)"
          :title="currentLectureId ? t('ai.clearLectureSessions') : t('ai.clearSessions')"
          @click="handleClearClick"
        >
          <span class="btn-icon" v-html="ICONS.trash"></span>
          <span class="btn-text">{{ isConfirmingClear ? t('ai.cancelClear') : (currentLectureId ? t('ai.clearLectureSessions') : t('ai.clearSessions')) }}</span>
        </button>
      </section>

      <!-- 二次确认清空条 -->
      <Transition name="fade">
        <div v-if="isConfirmingClear" class="clear-confirm-bar">
          <p class="confirm-message">{{ currentLectureId ? t('ai.clearConfirmLecture') : t('ai.clearConfirmAll') }}</p>
          <div class="confirm-buttons">
            <button
              type="button"
              class="confirm-btn danger"
              @click="confirmClearAll"
            >
              {{ t('ai.confirm') }}
            </button>
            <button
              type="button"
              class="confirm-btn cancel"
              @click="isConfirmingClear = false"
            >
              {{ t('ai.cancel') }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- 会话列表容器 -->
      <main class="drawer-content">
        <!-- 加载状态 -->
        <div v-if="isLoading" class="state-container loading-state">
          <span class="pulse-line"></span>
          <span class="state-text">{{ t('ai.loadingHistory') }}</span>
        </div>

        <!-- 空数据状态 -->
        <div v-else-if="allSessions.length === 0" class="state-container empty-state">
          <span class="empty-icon" v-html="ICONS.history"></span>
          <p class="empty-title">{{ t('ai.emptyHistoryTitle') }}</p>
          <p class="empty-subtitle">{{ t('ai.emptyHistorySubtitle') }}</p>
        </div>

        <!-- 历史会话三层分级列表 (议题 5: 本讲 -> 本组 -> 全站历史) -->
        <div v-else class="drawer-sections-wrapper">
          <!-- 1. 本讲/全站历史会话 -->
          <div v-if="currentLectureSessions.length > 0" class="history-category-block">
            <div class="category-header">
              <span class="category-title">{{ currentLectureId ? t('ai.historyGroupThisLecture') : t('ai.historyGroupAllSite') }}</span>
              <span class="category-count">{{ currentLectureSessions.length }}</span>
            </div>
            <ul class="session-list" role="list">
              <li
                v-for="sess in currentLectureSessions"
                :key="sess.id"
                class="session-item"
                :class="{ 'is-active': sess.id === activeSessionId }"
                role="listitem"
                @click="handleSelectSession(sess)"
              >
                <div class="session-main">
                  <div class="session-top">
                    <input
                      v-if="editingSessionId === sess.id"
                      v-model="editingTitle"
                      class="session-title-input"
                      type="text"
                      maxlength="36"
                      :placeholder="t('ai.sessionTitlePlaceholder')"
                      @click.stop
                      @keydown.enter.stop="saveRename(sess)"
                      @keydown.esc.stop="cancelRename"
                      @blur="saveRename(sess)"
                    />
                    <span
                      v-else
                      class="session-title"
                      :title="sess.title"
                      @dblclick.stop="startRename(sess)"
                    >
                      {{ sess.title || t('ai.userSessionDefault') }}
                    </span>
                    <span v-if="sess.id === activeSessionId" class="active-pill">
                      {{ t('ai.sessionCurrentBadge') }}
                    </span>
                  </div>
                  <div class="session-meta">
                    <time class="session-time" :datetime="sess.updated_at || sess.created_at">
                      {{ formatTime(sess.updated_at || sess.created_at) }}
                    </time>
                  </div>
                </div>

                <div class="session-actions" @click.stop>
                  <button
                    type="button"
                    class="session-action-btn"
                    :title="t('ai.renameHintTitle')"
                    :aria-label="t('ai.renameAria')"
                    @click.stop="startRename(sess)"
                  >
                    <span class="btn-icon" v-html="ICONS.edit"></span>
                  </button>
                  <button
                    type="button"
                    class="session-action-btn delete-btn"
                    :title="t('ai.deleteSessionTitle')"
                    :aria-label="t('ai.deleteSessionAria')"
                    @click.stop="handleDeleteSingle(sess.id)"
                  >
                    <span class="btn-icon" v-html="ICONS.trash"></span>
                  </button>
                </div>
              </li>
            </ul>
          </div>

          <!-- 2. 本课程组其他讲次会话 -->
          <div v-if="currentGroupSessions.length > 0" class="history-category-block">
            <div class="category-header">
              <span class="category-title">{{ t('ai.historyGroupPeers') }}</span>
              <span class="category-count">{{ currentGroupSessions.length }}</span>
            </div>
            <ul class="session-list" role="list">
              <li
                v-for="sess in currentGroupSessions"
                :key="sess.id"
                class="session-item is-jumpable"
                role="listitem"
                :title="t('ai.jumpToLectureTitle')"
                @click="handleSelectSession(sess)"
              >
                <div class="session-main">
                  <div class="session-top">
                    <span class="session-lec-tag">{{ sess.lecture_id?.toUpperCase() }}</span>
                    <input
                      v-if="editingSessionId === sess.id"
                      v-model="editingTitle"
                      class="session-title-input"
                      type="text"
                      maxlength="36"
                      :placeholder="t('ai.sessionTitlePlaceholder')"
                      @click.stop
                      @keydown.enter.stop="saveRename(sess)"
                      @keydown.esc.stop="cancelRename"
                      @blur="saveRename(sess)"
                    />
                    <span
                      v-else
                      class="session-title"
                      :title="sess.title"
                      @dblclick.stop="startRename(sess)"
                    >
                      {{ sess.title || t('ai.defaultTopicTitle') }}
                    </span>
                  </div>
                  <div class="session-meta">
                    <span class="jump-action-tip">{{ t('ai.jumpToLectureTip') }}</span>
                    <time class="session-time" :datetime="sess.updated_at || sess.created_at">
                      {{ formatTime(sess.updated_at || sess.created_at) }}
                    </time>
                  </div>
                </div>

                <div class="session-actions" @click.stop>
                  <button
                    type="button"
                    class="session-action-btn"
                    :title="t('ai.renameHintTitle')"
                    :aria-label="t('ai.renameAria')"
                    @click.stop="startRename(sess)"
                  >
                    <span class="btn-icon" v-html="ICONS.edit"></span>
                  </button>
                  <button
                    type="button"
                    class="session-action-btn delete-btn"
                    :title="t('ai.deleteSessionTitle')"
                    :aria-label="t('ai.deleteSessionAria')"
                    @click.stop="handleDeleteSingle(sess.id)"
                  >
                    <span class="btn-icon" v-html="ICONS.trash"></span>
                  </button>
                </div>
              </li>
            </ul>
          </div>

          <!-- 3. 全站其他讲次历史 -->
          <div v-if="otherSessions.length > 0" class="history-category-block">
            <div class="category-header">
              <span class="category-title">{{ t('ai.historyGroupOther') }}</span>
              <span class="category-count">{{ otherSessions.length }}</span>
            </div>
            <ul class="session-list" role="list">
              <li
                v-for="sess in otherSessions"
                :key="sess.id"
                class="session-item is-jumpable"
                role="listitem"
                :title="t('ai.jumpToLectureTitle')"
                @click="handleSelectSession(sess)"
              >
                <div class="session-main">
                  <div class="session-top">
                    <span class="session-lec-tag">{{ sess.lecture_id?.toUpperCase() }}</span>
                    <input
                      v-if="editingSessionId === sess.id"
                      v-model="editingTitle"
                      class="session-title-input"
                      type="text"
                      maxlength="36"
                      :placeholder="t('ai.sessionTitlePlaceholder')"
                      @click.stop
                      @keydown.enter.stop="saveRename(sess)"
                      @keydown.esc.stop="cancelRename"
                      @blur="saveRename(sess)"
                    />
                    <span
                      v-else
                      class="session-title"
                      :title="sess.title"
                      @dblclick.stop="startRename(sess)"
                    >
                      {{ sess.title || t('ai.defaultTopicTitle') }}
                    </span>
                  </div>
                  <div class="session-meta">
                    <span class="jump-action-tip">{{ t('ai.jumpToLectureTip') }}</span>
                    <time class="session-time" :datetime="sess.updated_at || sess.created_at">
                      {{ formatTime(sess.updated_at || sess.created_at) }}
                    </time>
                  </div>
                </div>

                <div class="session-actions" @click.stop>
                  <button
                    type="button"
                    class="session-action-btn"
                    :title="t('ai.renameHintTitle')"
                    :aria-label="t('ai.renameAria')"
                    @click.stop="startRename(sess)"
                  >
                    <span class="btn-icon" v-html="ICONS.edit"></span>
                  </button>
                  <button
                    type="button"
                    class="session-action-btn delete-btn"
                    :title="t('ai.deleteSessionTitle')"
                    :aria-label="t('ai.deleteSessionAria')"
                    @click.stop="handleDeleteSingle(sess.id)"
                  >
                    <span class="btn-icon" v-html="ICONS.trash"></span>
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </main>

      <!-- 抽屉底栏统计 -->
      <footer class="drawer-footer">
        <span class="footer-count">{{ t('ai.sessionIndexedCount', { count: allSessions.length }) }}</span>
        <span class="footer-hint">{{ t('ai.sessionIndexedHint') }}</span>
      </footer>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useData, useRouter } from 'vitepress'
import { useT } from '../../../i18n/useT.ts'
import { ICONS } from './icons'
import { companionSessionStore } from './sessionStore'
import { neonRepository, getAllSessions, type AiSession } from './neonRepository'
import { useLectureContext } from './useLectureContext'
import { showMessageToast } from './toast'

const { t } = useT()
const { theme } = useData()
const drawerRef = ref<HTMLElement | null>(null)
const closeBtnRef = ref<HTMLButtonElement | null>(null)
let lastFocusedBeforeDrawer: HTMLElement | null = null
let focusDrawerTimer: number | null = null
let windowKeydownAttached = false

function attachDrawerKeydown(): void {
  if (typeof window === 'undefined' || windowKeydownAttached) return
  window.addEventListener('keydown', handleDrawerKeydown, true)
  windowKeydownAttached = true
}

function detachDrawerKeydown(): void {
  if (typeof window === 'undefined' || !windowKeydownAttached) return
  window.removeEventListener('keydown', handleDrawerKeydown, true)
  windowKeydownAttached = false
}

function clearDrawerFocusTimer(): void {
  if (typeof window !== 'undefined' && focusDrawerTimer !== null) {
    window.clearTimeout(focusDrawerTimer)
    focusDrawerTimer = null
  }
}

function scheduleFocusCloseButton(): void {
  clearDrawerFocusTimer()
  void nextTick(() => closeBtnRef.value?.focus())
  if (typeof window !== 'undefined') {
    focusDrawerTimer = window.setTimeout(() => {
      focusDrawerTimer = null
      if (props.isOpen && drawerRef.value && !drawerRef.value.contains(document.activeElement)) {
        closeBtnRef.value?.focus()
      }
    }, 40)
  }
}

function handleDrawerKeydown(e: KeyboardEvent): void {
  if (!props.isOpen) return
  if (e.key === 'Escape') {
    if (editingSessionId.value !== null) return
    e.preventDefault()
    e.stopPropagation()
    handleClose()
    return
  }
  if (e.key !== 'Tab' || !drawerRef.value) return
  const focusables = Array.from(
    drawerRef.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement)
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement as HTMLElement | null
  const inside = Boolean(active && drawerRef.value.contains(active))
  if (!inside || (!e.shiftKey && active === last)) {
    e.preventDefault()
    e.stopPropagation()
    ;(e.shiftKey && !inside ? last : first).focus()
  } else if (e.shiftKey && active === first) {
    e.preventDefault()
    e.stopPropagation()
    last.focus()
  }
}

interface Props {
  isOpen: boolean
  lectureId?: string
  groupId?: string
  currentSessionId?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  lectureId: '',
  groupId: '',
  currentSessionId: null
})

const emit = defineEmits<{
  (e: 'update:isOpen', value: boolean): void
  (e: 'select-session', sessionId: string): void
  (e: 'create-session', session: AiSession): void
  (e: 'delete-session', sessionId: string): void
  (e: 'clear-sessions'): void
}>()

const router = useRouter()
const { lectureInfo } = useLectureContext()

const allSessions = ref<AiSession[]>([])
const sessions = ref<AiSession[]>([])
const isLoading = ref<boolean>(false)
const isConfirmingClear = ref<boolean>(false)

// 当前讲次 ID
const currentLectureId = computed<string>(() => {
  return props.lectureId || lectureInfo.value.lectureId || ''
})

// 当前课程组 ID
const currentGroupId = computed<string>(() => {
  return props.groupId || lectureInfo.value.groupId || ''
})

// 当前激活的会话 ID（统一来自 companionSessionStore 单一真源，FE-012）
const activeSessionId = computed<string | null>(() => {
  return props.currentSessionId || companionSessionStore.activeSessionId.value || null
})

// 讲次标签徽章
const lectureBadge = computed<string>(() => {
  return currentLectureId.value ? currentLectureId.value.toUpperCase() : ''
})

// 三层分级会话列表计算属性 (议题 5)
const currentLectureSessions = computed<AiSession[]>(() => {
  if (!currentLectureId.value) return allSessions.value
  return allSessions.value.filter(
    (s) => s.lecture_id?.toLowerCase() === currentLectureId.value?.toLowerCase()
  )
})

const currentGroupSessions = computed<AiSession[]>(() => {
  if (!currentGroupId.value) return []
  return allSessions.value.filter(
    (s) =>
      s.lecture_id?.toLowerCase() !== currentLectureId.value?.toLowerCase() &&
      s.group_id?.toLowerCase() === currentGroupId.value?.toLowerCase()
  )
})

const otherSessions = computed<AiSession[]>(() => {
  if (!currentGroupId.value) return []
  return allSessions.value.filter(
    (s) => s.group_id?.toLowerCase() !== currentGroupId.value?.toLowerCase()
  )
})

// 格式化时间戳 (SSR 安全)
function formatTime(isoString?: string): string {
  if (!isoString) return ''
  try {
    const d = new Date(isoString)
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
}

// 重命名交互状态
const editingSessionId = ref<string | null>(null)
const editingTitle = ref<string>('')

function startRename(sess: AiSession): void {
  editingSessionId.value = sess.id
  editingTitle.value = sess.title || ''
  setTimeout(() => {
    const el = document.querySelector('.session-title-input') as HTMLInputElement | null
    if (el) {
      el.focus()
      el.select()
    }
  }, 50)
}

function cancelRename(): void {
  editingSessionId.value = null
  editingTitle.value = ''
}

async function saveRename(sess: AiSession): Promise<void> {
  if (!editingSessionId.value || editingSessionId.value !== sess.id) return
  const newTitle = editingTitle.value.trim()
  editingSessionId.value = null
  if (newTitle && newTitle !== sess.title) {
    try {
      await neonRepository.updateSessionTitle(sess.id, newTitle, sess.lecture_id)
      sess.title = newTitle
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : t('ai.networkError')
      showMessageToast(t('ai.errPersistFailed', { detail }))
    }
  }
}

/** Determine whether title is an auto placeholder title. */
function isGenericTitle(title?: string): boolean {
  if (!title || !title.trim()) return true
  const raw = title.trim()
  return /^(\u4f1a\u8bdd\s*\d*|\u65b0\u4f1a\u8bdd|\u65b0\u63a2\u8ba8|\u5168\u7ad9\u63a2\u8ba8\s*\d*|\u63a2\u8ba8:\s*\u5168\u7ad9\u5bfc\u8bfb|session\s*\d*|new session|new topic|site topic\s*\d*)$/i.test(raw)
}

/** Auto-heal placeholder session titles from the first user prompt. */
async function healGenericSessionTitles(sessionList: AiSession[]): Promise<void> {
  const genericSessions = sessionList.filter((s) => isGenericTitle(s.title))
  if (genericSessions.length === 0) return

  for (const s of genericSessions) {
    try {
      const msgs = await neonRepository.getMessages(s.id)
      const firstUserMsg = msgs.find(
        (m) => m.role === 'user' && m.content && m.content.trim().length > 0
      )
      if (firstUserMsg) {
        const cleanContent = firstUserMsg.content
          .replace(/^\[(?:\u7cfb\u7edf\u6ce8\u5165\u4e0a\u4e0b\u6587|System Context).*?\]\s*/s, '')
          .replace(/[\r\n]+/g, ' ')
          .trim()
        const refinedTitle = cleanContent.slice(0, 22).trim()
        if (refinedTitle && refinedTitle !== s.title) {
          await neonRepository.updateSessionTitle(s.id, refinedTitle, s.lecture_id)
          s.title = refinedTitle
        }
      }
    } catch {
      // Ignore single-item auto-heal errors so drawer listing remains smooth
    }
  }
}

// 加载全站与当前讲的历史会话列表（不在打开抽屉时无条件清理新建会话，FE-009）
async function loadSessions(): Promise<void> {
  isLoading.value = true
  try {
    const list = await getAllSessions()
    const draft = companionSessionStore.draftSession.value
    const merged = draft && !list.some((s) => s.id === draft.id) ? [draft, ...list] : list
    allSessions.value = Array.isArray(merged) ? merged : []
    const curr = allSessions.value.filter(
      (s) => s.lecture_id?.toLowerCase() === currentLectureId.value?.toLowerCase()
    )
    sessions.value = curr

    // 后台静默自愈默认无意义的占位标题（提取首问）
    void healGenericSessionTitles(list)
  } catch {
    allSessions.value = []
    sessions.value = []
  } finally {
    isLoading.value = false
  }
}

// 选择会话与跨讲深层跳转
async function handleSelectSession(sess: AiSession): Promise<void> {
  // 如果当前正在重命名该会话，不触发切换跳转
  if (editingSessionId.value === sess.id) return

  const isCurrent = sess.lecture_id?.toLowerCase() === currentLectureId.value?.toLowerCase()

  if (isCurrent) {
    companionSessionStore.markExplicitSelection(sess)
    emit('select-session', sess.id)
    emit('update:isOpen', false)
    return
  }

  // 跨讲精准跳转逻辑（从 theme.groups 解析真实 group.dir，兼容 nested 路径 FE-035）
  const groups = ((theme.value as { groups?: Array<{ id?: string; dir?: string }> })?.groups || [])
  const rawGrp = (sess.group_id || 'g01').toLowerCase()
  const matchedGrp = groups.find(
    (g) => g.dir?.toLowerCase() === rawGrp || g.id?.toLowerCase() === rawGrp || g.dir?.toLowerCase().endsWith(`/${rawGrp}`)
  )
  const grpDir = (matchedGrp?.dir || rawGrp).replace(/^\/+|\/+$/g, '')
  const lecMatch = sess.lecture_id.match(/L(\d+)/i)
  const lecNum = lecMatch ? `L${lecMatch[1].padStart(2, '0')}` : 'L01'
  const targetRoute = `/${grpDir}/${lecNum}`

  let selectedTextToScroll = ''
  try {
    const msgs = await neonRepository.getMessages(sess.id)
    const quoteMsg = msgs.find(
      (m) => m.selected_context && m.selected_context !== '\u65e0' && m.selected_context !== 'None' && m.selected_context.trim().length > 0
    )
    if (quoteMsg?.selected_context) {
      selectedTextToScroll = quoteMsg.selected_context.trim()
    }
  } catch {
    // ignore
  }

  // 保留跨讲显式选择的会话（路由 watcher 不再被 sessions[0] 覆盖，FE-008）
  companionSessionStore.markExplicitSelection(sess)
  emit('select-session', sess.id)
  emit('update:isOpen', false)

  if (router && typeof router.go === 'function') {
    await router.go(targetRoute)
  } else if (typeof window !== 'undefined') {
    window.location.href = targetRoute
  }

  if (typeof window !== 'undefined') {
    setTimeout(() => {
      if (selectedTextToScroll) {
        const docEl = document.querySelector('.vp-doc')
        if (docEl) {
          const elements = Array.from(docEl.querySelectorAll('p, h2, h3, li, blockquote, figure'))
          const targetEl = elements.find((el) =>
            el.textContent?.includes(selectedTextToScroll.slice(0, 30))
          )
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
            targetEl.classList.add('cite-flash')
            setTimeout(() => targetEl.classList.remove('cite-flash'), 1800)
            return
          }
        }
      }
      // 无选区划词则平滑回到该讲顶部
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }, 420)
  }
}

// 新建会话（仅建立本地惰性草稿，首问成功后再落库，FE-009）
async function handleCreateSession(): Promise<void> {
  const isHome = !currentLectureId.value
  const lecId = currentLectureId.value || 'global'
  const grpId = currentGroupId.value || 'general'

  const existingNums = allSessions.value
    .map((s) => {
      const m =
        s.title?.match(/\u4f1a\u8bdd\s*(\d+)/) ||
        s.title?.match(/\u5168\u7ad9\u63a2\u8ba8\s*(\d+)/) ||
        s.title?.match(/(?:Session|Site topic)\s*(\d+)/i)
      return m ? parseInt(m[1], 10) : 0
    })
    .filter((n) => !isNaN(n))
  const maxNum = existingNums.length > 0 ? Math.max(...existingNums) : allSessions.value.length
  const nextIndex = maxNum + 1

  const title = isHome
    ? t('ai.siteTopicIndexed', { n: nextIndex })
    : t('ai.lectureSessionIndexed', { n: nextIndex })
  const draftSession = companionSessionStore.startNewDraft(lecId, grpId, title)
  allSessions.value.unshift(draftSession)
  if (!isHome) {
    sessions.value.unshift(draftSession)
  }
  emit('create-session', draftSession)
  emit('update:isOpen', false)
}

// 删除单个会话
async function handleDeleteSingle(sessionId: string): Promise<void> {
  try {
    await neonRepository.deleteSession(sessionId, currentLectureId.value)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    allSessions.value = allSessions.value.filter(s => s.id !== sessionId)
    emit('delete-session', sessionId)

    // 若删除的是当前正在对话的会话，自动切换到剩余第一项或清空
    if (companionSessionStore.activeSessionId.value === sessionId) {
      const remaining = currentLectureId.value ? sessions.value : allSessions.value
      if (remaining.length > 0 && remaining[0]) {
        companionSessionStore.activeSessionId.value = remaining[0].id
        emit('select-session', remaining[0].id)
      } else {
        companionSessionStore.activeSessionId.value = ''
      }
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : t('ai.networkError')
    showMessageToast(t('ai.errPersistFailed', { detail }))
  }
}

function handleClearClick(): void {
  isConfirmingClear.value = !isConfirmingClear.value
}

async function confirmClearAll(): Promise<void> {
  const lecId = currentLectureId.value
  isLoading.value = true
  isConfirmingClear.value = false
  try {
    if (!lecId) {
      for (const s of allSessions.value) {
        await neonRepository.deleteSession(s.id, s.lecture_id)
      }
      allSessions.value = []
      sessions.value = []
    } else {
      await neonRepository.clearSessions(lecId)
      sessions.value = []
      allSessions.value = allSessions.value.filter(
        (s) => s.lecture_id?.toLowerCase() !== lecId.toLowerCase()
      )
    }
    companionSessionStore.activeSessionId.value = ''
    emit('clear-sessions')
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : t('ai.networkError')
    showMessageToast(t('ai.errPersistFailed', { detail }))
  } finally {
    isLoading.value = false
  }
}

// 关闭抽屉
function handleClose(): void {
  isConfirmingClear.value = false
  emit('update:isOpen', false)
}

// 监听抽屉展开状态
watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      isConfirmingClear.value = false
      loadSessions()
      if (typeof document !== 'undefined') {
        lastFocusedBeforeDrawer = document.activeElement as HTMLElement | null
        attachDrawerKeydown()
        scheduleFocusCloseButton()
      }
    } else {
      clearDrawerFocusTimer()
      detachDrawerKeydown()
      if (
        typeof document !== 'undefined' &&
        lastFocusedBeforeDrawer &&
        lastFocusedBeforeDrawer.isConnected
      ) {
        const target = lastFocusedBeforeDrawer
        lastFocusedBeforeDrawer = null
        void nextTick(() => target.focus())
      } else {
        lastFocusedBeforeDrawer = null
      }
    }
  }
)

// 监听当前讲 ID 变化
watch(
  () => currentLectureId.value,
  () => {
    if (props.isOpen) {
      loadSessions()
    }
  }
)

onMounted(() => {
  if (props.isOpen) {
    loadSessions()
    attachDrawerKeydown()
    scheduleFocusCloseButton()
  }
})

onUnmounted(() => {
  clearDrawerFocusTimer()
  detachDrawerKeydown()
})

defineExpose({
  loadSessions,
  createSession: handleCreateSession,
  clearSessions: confirmClearAll
})
</script>

<style scoped>
.session-history-drawer {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background-color: var(--lec-bg);
  border-left: 1px solid var(--lec-border);
  font-size: 13px;
  color: var(--lec-text);
  overflow: hidden;
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--lec-border);
  background-color: var(--lec-surface);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--lec-accent);
}

.header-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--lec-text);
}

.lecture-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 11px;
  font-family: var(--lec-font-mono);
  font-weight: 500;
  color: var(--lec-accent);
  background-color: var(--lec-accent-tint);
  border-radius: var(--lec-radius-1);
}

.header-close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--lec-text-muted);
  border-radius: var(--lec-radius-1);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.header-close-btn:hover {
  background-color: var(--lec-bg);
  color: var(--lec-text);
}

.drawer-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--lec-border);
  background-color: var(--lec-bg);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--lec-radius-1);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid transparent;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-create {
  flex: 1;
  background-color: var(--lec-accent);
  color: var(--lec-on-accent);
  border-color: var(--lec-accent);
}

.action-create:hover:not(:disabled) {
  filter: brightness(1.08);
}

.action-clear {
  flex: 1;
  background-color: var(--lec-surface);
  color: var(--lec-text-muted);
  border-color: var(--lec-border);
}

.action-clear:hover:not(:disabled) {
  background-color: var(--lec-danger-tint);
  color: var(--lec-danger);
  border-color: var(--lec-danger);
}

.action-clear.is-confirming {
  background-color: var(--lec-danger-tint);
  color: var(--lec-danger);
  border-color: var(--lec-danger);
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.clear-confirm-bar {
  padding: 10px 14px;
  background-color: var(--lec-danger-tint);
  border-bottom: 1px solid var(--lec-danger);
}

.confirm-message {
  margin: 0 0 8px 0;
  font-size: 12px;
  color: var(--lec-danger);
  line-height: 1.4;
}

.confirm-buttons {
  display: flex;
  gap: 8px;
}

.confirm-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  border-radius: var(--lec-radius-1);
  cursor: pointer;
  border: 1px solid transparent;
}

.confirm-btn.danger {
  background-color: var(--lec-danger);
  color: var(--lec-on-accent);
}

.confirm-btn.cancel {
  background-color: var(--lec-bg);
  color: var(--lec-text-muted);
  border-color: var(--lec-border);
}

.drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.state-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 200px;
  text-align: center;
  padding: 24px 16px;
  color: var(--lec-text-muted);
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--lec-text-muted);
  margin-bottom: 12px;
}

.empty-title {
  margin: 0 0 6px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--lec-text-muted);
}

.empty-subtitle {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--lec-text-muted);
}

.pulse-line {
  width: 32px;
  height: 2px;
  background-color: var(--lec-accent);
  border-radius: 1px;
  margin-bottom: 10px;
  animation: pulse-width 1.2s infinite ease-in-out;
}

@keyframes pulse-width {
  0%, 100% { transform: scaleX(0.6); opacity: 0.4; }
  50% { transform: scaleX(1.4); opacity: 1; }
}

.state-text {
  font-size: 12px;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
  background-color: var(--lec-bg);
  cursor: pointer;
  transition: all 0.15s ease;
}

.session-item:hover {
  background-color: var(--lec-surface);
  border-color: var(--lec-accent);
}

.session-item.is-active {
  background-color: var(--lec-accent-tint);
  border-color: var(--lec-accent);
}

.session-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.session-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.session-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--lec-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-pill {
  flex-shrink: 0;
  padding: 0 4px;
  font-size: 10px;
  border-radius: var(--lec-radius-1);
  background-color: var(--lec-accent);
  color: var(--lec-on-accent);
}

.session-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-time {
  font-size: 11px;
  font-family: var(--lec-font-mono);
  color: var(--lec-text-muted);
}

.session-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  flex-shrink: 0;
}

.session-action-btn {
  opacity: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--lec-text-muted);
  border-radius: var(--lec-radius-1);
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease, background-color 0.15s ease;
}

.session-item:hover .session-action-btn,
.session-item:focus-within .session-action-btn {
  opacity: 1;
}

.session-action-btn:hover {
  background-color: var(--lec-surface);
  color: var(--lec-accent);
}

.session-action-btn.delete-btn:hover {
  background-color: var(--lec-danger-tint);
  color: var(--lec-danger);
}

.session-title-input {
  width: 100%;
  font-size: 13px;
  font-weight: 500;
  color: var(--lec-text);
  background-color: var(--lec-bg);
  border: 1px solid var(--lec-accent);
  border-radius: var(--lec-radius-1);
  padding: 1px 6px;
  outline: 2px solid var(--lec-accent-tint);
}

.drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--lec-border);
  background-color: var(--lec-surface);
  font-size: 11px;
  color: var(--lec-text-muted);
}

.footer-count {
  font-family: var(--lec-font-mono);
}

.history-category-block {
  margin-bottom: 18px;
}
.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--lec-text-muted);
  letter-spacing: 0.5px;
}
.category-count {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  font-family: var(--lec-font-mono);
}
.session-lec-tag {
  font-size: 10px;
  font-weight: 600;
  font-family: var(--lec-font-mono);
  padding: 1px 5px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-accent-tint);
  color: var(--lec-accent);
  margin-right: 4px;
  flex-shrink: 0;
}
.jump-action-tip {
  font-size: 10.5px;
  color: var(--lec-accent);
}
.session-item.is-jumpable:hover .jump-action-tip {
  text-decoration: underline;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
