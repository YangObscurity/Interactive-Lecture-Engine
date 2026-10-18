<template>
  <Transition name="drawer-slide">
    <div
      v-if="isOpen"
      class="session-history-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="历史会话管理抽屉"
    >
      <!-- 抽屉顶栏 -->
      <header class="drawer-header">
        <div class="header-left">
          <span class="header-icon" v-html="ICONS.history"></span>
          <h3 class="header-title">历史会话</h3>
          <span v-if="lectureBadge" class="lecture-badge">{{ lectureBadge }}</span>
        </div>
        <button
          type="button"
          class="header-close-btn"
          title="关闭历史抽屉"
          aria-label="关闭历史抽屉"
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
          :title="currentLectureId ? '新建当前讲会话' : '新建会话'"
          :disabled="isLoading"
          @click="handleCreateSession"
        >
          <span class="btn-icon" v-html="ICONS.plus"></span>
          <span class="btn-text">新建会话</span>
        </button>

        <button
          type="button"
          class="action-btn action-clear"
          :class="{ 'is-confirming': isConfirmingClear }"
          :disabled="isLoading || (currentLectureId ? sessions.length === 0 : allSessions.length === 0)"
          :title="currentLectureId ? '清空当前讲会话' : '清空历史会话'"
          @click="handleClearClick"
        >
          <span class="btn-icon" v-html="ICONS.trash"></span>
          <span class="btn-text">{{ isConfirmingClear ? '取消清空' : (currentLectureId ? '清空当前讲会话' : '清空历史会话') }}</span>
        </button>
      </section>

      <!-- 二次确认清空条 -->
      <Transition name="fade">
        <div v-if="isConfirmingClear" class="clear-confirm-bar">
          <p class="confirm-message">{{ currentLectureId ? '确定清空本讲所有历史会话？数据不可恢复。' : '确定清空所有历史会话？数据不可恢复。' }}</p>
          <div class="confirm-buttons">
            <button
              type="button"
              class="confirm-btn danger"
              @click="confirmClearAll"
            >
              确认清空
            </button>
            <button
              type="button"
              class="confirm-btn cancel"
              @click="isConfirmingClear = false"
            >
              取消
            </button>
          </div>
        </div>
      </Transition>

      <!-- 会话列表容器 -->
      <main class="drawer-content">
        <!-- 加载状态 -->
        <div v-if="isLoading" class="state-container loading-state">
          <span class="pulse-line"></span>
          <span class="state-text">正在读取历史会话...</span>
        </div>

        <!-- 空数据状态 -->
        <div v-else-if="allSessions.length === 0" class="state-container empty-state">
          <span class="empty-icon" v-html="ICONS.history"></span>
          <p class="empty-title">当前暂无历史会话</p>
          <p class="empty-subtitle">点击上方「新建会话」即可开启多轮技术探讨</p>
        </div>

        <!-- 历史会话三层分级列表 (议题 5: 本讲 -> 本组 -> 全站历史) -->
        <div v-else class="drawer-sections-wrapper">
          <!-- 1. 本讲/全站历史会话 -->
          <div v-if="currentLectureSessions.length > 0" class="history-category-block">
            <div class="category-header">
              <span class="category-title">{{ currentLectureId ? '本讲会话' : '全站历史会话' }}</span>
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
                      placeholder="输入会话主题..."
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
                      {{ sess.title || '新会话' }}
                    </span>
                    <span v-if="sess.id === activeSessionId" class="active-pill">
                      当前
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
                    title="重命名（双击标题亦可修改）"
                    aria-label="重命名会话"
                    @click.stop="startRename(sess)"
                  >
                    <span class="btn-icon" v-html="ICONS.edit"></span>
                  </button>
                  <button
                    type="button"
                    class="session-action-btn delete-btn"
                    title="删除该会话"
                    aria-label="删除该会话"
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
              <span class="category-title">本课程组其他讲次</span>
              <span class="category-count">{{ currentGroupSessions.length }}</span>
            </div>
            <ul class="session-list" role="list">
              <li
                v-for="sess in currentGroupSessions"
                :key="sess.id"
                class="session-item is-jumpable"
                role="listitem"
                title="点击一键跳转回该讲提问位置"
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
                      placeholder="输入会话主题..."
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
                      {{ sess.title || '新探讨' }}
                    </span>
                  </div>
                  <div class="session-meta">
                    <span class="jump-action-tip">点击一键跳转回该讲</span>
                    <time class="session-time" :datetime="sess.updated_at || sess.created_at">
                      {{ formatTime(sess.updated_at || sess.created_at) }}
                    </time>
                  </div>
                </div>

                <div class="session-actions" @click.stop>
                  <button
                    type="button"
                    class="session-action-btn"
                    title="重命名（双击标题亦可修改）"
                    aria-label="重命名会话"
                    @click.stop="startRename(sess)"
                  >
                    <span class="btn-icon" v-html="ICONS.edit"></span>
                  </button>
                  <button
                    type="button"
                    class="session-action-btn delete-btn"
                    title="删除该会话"
                    aria-label="删除该会话"
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
              <span class="category-title">全站其他历史</span>
              <span class="category-count">{{ otherSessions.length }}</span>
            </div>
            <ul class="session-list" role="list">
              <li
                v-for="sess in otherSessions"
                :key="sess.id"
                class="session-item is-jumpable"
                role="listitem"
                title="点击一键跳转回该讲提问位置"
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
                      placeholder="输入会话主题..."
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
                      {{ sess.title || '新探讨' }}
                    </span>
                  </div>
                  <div class="session-meta">
                    <span class="jump-action-tip">点击一键跳转回该讲</span>
                    <time class="session-time" :datetime="sess.updated_at || sess.created_at">
                      {{ formatTime(sess.updated_at || sess.created_at) }}
                    </time>
                  </div>
                </div>

                <div class="session-actions" @click.stop>
                  <button
                    type="button"
                    class="session-action-btn"
                    title="重命名（双击标题亦可修改）"
                    aria-label="重命名会话"
                    @click.stop="startRename(sess)"
                  >
                    <span class="btn-icon" v-html="ICONS.edit"></span>
                  </button>
                  <button
                    type="button"
                    class="session-action-btn delete-btn"
                    title="删除该会话"
                    aria-label="删除该会话"
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
        <span class="footer-count">全站共 {{ allSessions.length }} 个会话</span>
        <span class="footer-hint">分层对齐索引</span>
      </footer>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vitepress'
import { ICONS } from './icons'
import { aiState } from './aiState'
import { neonRepository, getAllSessions, purgeEmptySessions, type AiSession } from './neonRepository'
import { useLectureContext } from './useLectureContext'

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

// 当前激活的会话 ID
const activeSessionId = computed<string | null>(() => {
  return props.currentSessionId || aiState.currentSessionId
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
    sess.title = newTitle
    await neonRepository.updateSessionTitle(sess.id, newTitle, sess.lecture_id)
  }
}

/** 判定标题是否为无意义的默认占位名（如“会话 1”, “会话 2”, “新会话”等） */
function isGenericTitle(title?: string): boolean {
  if (!title || !title.trim()) return true
  const t = title.trim()
  return /^(会话\s*\d*|新会话|新探讨|全站探讨\s*\d*|探讨:\s*全站导读)$/i.test(t)
}

/** 自动为缺乏语义的老会话提炼首问并回写自愈（彻底终结“会话 1”占位符） */
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
        // 清理系统注入上下文前缀，提取纯粹的用户提问
        const cleanContent = firstUserMsg.content
          .replace(/^\[系统注入上下文.*?\]\s*/s, '')
          .replace(/[\r\n]+/g, ' ')
          .trim()
        const refinedTitle = cleanContent.slice(0, 22).trim()
        if (refinedTitle && refinedTitle !== s.title) {
          s.title = refinedTitle
          await neonRepository.updateSessionTitle(s.id, refinedTitle, s.lecture_id)
        }
      }
    } catch {
      // 忽略单项自愈异常
    }
  }
}

// 加载全站与当前讲的历史会话列表
async function loadSessions(): Promise<void> {
  isLoading.value = true
  try {
    // 自动清洗历史累积的无消息幽灵会话
    purgeEmptySessions()

    const list = await getAllSessions()
    allSessions.value = Array.isArray(list) ? list : []
    const curr = allSessions.value.filter(
      (s) => s.lecture_id?.toLowerCase() === currentLectureId.value?.toLowerCase()
    )
    sessions.value = curr

    // 若当前无激活会话，且存在已有会话，默认对齐第一个
    if (!aiState.currentSessionId && curr.length > 0) {
      aiState.currentSessionId = curr[0].id
    }

    // 后台静默自愈默认无意义的占位标题（提取首问）
    void healGenericSessionTitles(allSessions.value)
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
    aiState.currentSessionId = sess.id
    emit('select-session', sess.id)
    emit('update:isOpen', false)
    return
  }

  // 跨讲精准跳转逻辑 (议题 5)
  const grp = (sess.group_id || 'g01').toLowerCase()
  const lecMatch = sess.lecture_id.match(/L\d+/i)
  const lecNum = lecMatch ? lecMatch[0] : 'L01'
  const targetRoute = `/${grp}/${lecNum}`

  let selectedTextToScroll = ''
  try {
    const msgs = await neonRepository.getMessages(sess.id)
    const quoteMsg = msgs.find(
      (m) => m.selected_context && m.selected_context !== '无' && m.selected_context.trim().length > 0
    )
    if (quoteMsg?.selected_context) {
      selectedTextToScroll = quoteMsg.selected_context.trim()
    }
  } catch {
    // ignore
  }

  aiState.currentSessionId = sess.id
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

// 新建会话
async function handleCreateSession(): Promise<void> {
  const isHome = !currentLectureId.value
  const lecId = currentLectureId.value || 'global'
  const grpId = currentGroupId.value || 'general'

  isLoading.value = true
  try {
    // 智能排重：扫描已有全部会话中的序号，取最大值 + 1，杜绝重复出现“会话 1”
    const existingNums = allSessions.value
      .map((s) => {
        const m = s.title?.match(/会话\s*(\d+)/) || s.title?.match(/全站探讨\s*(\d+)/)
        return m ? parseInt(m[1], 10) : 0
      })
      .filter((n) => !isNaN(n))
    const maxNum = existingNums.length > 0 ? Math.max(...existingNums) : allSessions.value.length
    const nextIndex = maxNum + 1

    const title = isHome ? `全站探讨 ${nextIndex}` : `会话 ${nextIndex}`
    const newSession = await neonRepository.createSession(lecId, grpId, title)
    allSessions.value.unshift(newSession)
    if (!isHome) {
      sessions.value.unshift(newSession)
    }
    aiState.currentSessionId = newSession.id
    emit('create-session', newSession)
    emit('select-session', newSession.id)
    emit('update:isOpen', false)
  } catch {
    // 错误处理已由仓储兜底
  } finally {
    isLoading.value = false
  }
}

// 删除单个会话
async function handleDeleteSingle(sessionId: string): Promise<void> {
  try {
    await neonRepository.deleteSession(sessionId, currentLectureId.value)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    allSessions.value = allSessions.value.filter(s => s.id !== sessionId)
    emit('delete-session', sessionId)

    // 若删除的是当前正在对话的会话，自动切换到剩余第一项或清空
    if (aiState.currentSessionId === sessionId) {
      const remaining = currentLectureId.value ? sessions.value : allSessions.value
      if (remaining.length > 0) {
        aiState.currentSessionId = remaining[0].id
        emit('select-session', remaining[0].id)
      } else {
        aiState.currentSessionId = null
      }
    }
  } catch {
    // 忽略异常
  }
}

// 点击清空按钮（触发展开二次确认）
function handleClearClick(): void {
  isConfirmingClear.value = !isConfirmingClear.value
}

// 确认清空当前讲或全站所有会话
async function confirmClearAll(): Promise<void> {
  const lecId = currentLectureId.value
  isLoading.value = true
  isConfirmingClear.value = false
  try {
    if (!lecId) {
      // 首页清空全站会话
      for (const s of allSessions.value) {
        await neonRepository.deleteSession(s.id, s.lecture_id)
      }
      allSessions.value = []
      sessions.value = []
    } else {
      // 单讲清空
      await neonRepository.clearSessions(lecId)
      sessions.value = []
      allSessions.value = allSessions.value.filter(
        (s) => s.lecture_id?.toLowerCase() !== lecId.toLowerCase()
      )
    }
    aiState.currentSessionId = null
    emit('clear-sessions')
  } catch {
    // 忽略异常
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
  }
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
  background-color: var(--vp-c-bg, #ffffff);
  border-left: 1px solid var(--vp-c-border, #e2e8f0);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.08);
  font-size: 13px;
  color: var(--vp-c-text-1, #1a202c);
  overflow: hidden;
}

/* 抽屉平滑滑出过渡 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* 顶栏 */
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--vp-c-border, #e2e8f0);
  background-color: var(--vp-c-bg-soft, #f8fafc);
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
  color: var(--vp-c-brand-1, #3b82f6);
}

.header-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1, #1a202c);
}

.lecture-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 11px;
  font-family: var(--vp-font-family-mono, monospace);
  font-weight: 500;
  color: var(--vp-c-brand-1, #3b82f6);
  background-color: var(--vp-c-brand-soft, rgba(59, 130, 246, 0.1));
  border-radius: 4px;
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
  color: var(--vp-c-text-2, #64748b);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.header-close-btn:hover {
  background-color: var(--vp-c-bg-alt, #f1f5f9);
  color: var(--vp-c-text-1, #0f172a);
}

/* 操作按钮组 */
.drawer-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vp-c-border, #e2e8f0);
  background-color: var(--vp-c-bg, #ffffff);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
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
  background-color: var(--vp-c-brand-1, #3b82f6);
  color: #ffffff;
  border-color: var(--vp-c-brand-1, #3b82f6);
}

.action-create:hover:not(:disabled) {
  filter: brightness(1.08);
}

.action-clear {
  flex: 1;
  background-color: var(--vp-c-bg-alt, #f1f5f9);
  color: var(--vp-c-text-2, #64748b);
  border-color: var(--vp-c-border, #e2e8f0);
}

.action-clear:hover:not(:disabled) {
  background-color: var(--vp-c-danger-soft, rgba(239, 68, 68, 0.1));
  color: var(--vp-c-danger-1, #ef4444);
  border-color: var(--vp-c-danger-1, #ef4444);
}

.action-clear.is-confirming {
  background-color: var(--vp-c-danger-soft, rgba(239, 68, 68, 0.1));
  color: var(--vp-c-danger-1, #ef4444);
  border-color: var(--vp-c-danger-1, #ef4444);
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* 清空确认弹条 */
.clear-confirm-bar {
  padding: 10px 14px;
  background-color: var(--vp-c-danger-soft, rgba(239, 68, 68, 0.08));
  border-bottom: 1px solid var(--vp-c-danger-1, #ef4444);
}

.confirm-message {
  margin: 0 0 8px 0;
  font-size: 12px;
  color: var(--vp-c-danger-1, #ef4444);
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
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}

.confirm-btn.danger {
  background-color: var(--vp-c-danger-1, #ef4444);
  color: #ffffff;
}

.confirm-btn.cancel {
  background-color: var(--vp-c-bg, #ffffff);
  color: var(--vp-c-text-2, #64748b);
  border-color: var(--vp-c-border, #e2e8f0);
}

/* 列表区 */
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
  color: var(--vp-c-text-3, #94a3b8);
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3, #94a3b8);
  margin-bottom: 12px;
}

.empty-title {
  margin: 0 0 6px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2, #64748b);
}

.empty-subtitle {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vp-c-text-3, #94a3b8);
}

.pulse-line {
  width: 32px;
  height: 2px;
  background-color: var(--vp-c-brand-1, #3b82f6);
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

/* 列表项 */
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
  border-radius: 6px;
  border: 1px solid var(--vp-c-border, #e2e8f0);
  background-color: var(--vp-c-bg, #ffffff);
  cursor: pointer;
  transition: all 0.15s ease;
}

.session-item:hover {
  background-color: var(--vp-c-bg-soft, #f8fafc);
  border-color: var(--vp-c-brand-soft, #cbd5e1);
}

.session-item.is-active {
  background-color: var(--vp-c-brand-soft, rgba(59, 130, 246, 0.08));
  border-color: var(--vp-c-brand-1, #3b82f6);
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
  color: var(--vp-c-text-1, #1a202c);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-pill {
  flex-shrink: 0;
  padding: 0 4px;
  font-size: 10px;
  border-radius: 3px;
  background-color: var(--vp-c-brand-1, #3b82f6);
  color: #ffffff;
}

.session-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-time {
  font-size: 11px;
  font-family: var(--vp-font-family-mono, monospace);
  color: var(--vp-c-text-3, #94a3b8);
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
  color: var(--vp-c-text-3, #94a3b8);
  border-radius: 4px;
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease, background-color 0.15s ease;
}

.session-item:hover .session-action-btn,
.session-item:focus-within .session-action-btn {
  opacity: 1;
}

.session-action-btn:hover {
  background-color: var(--vp-c-bg-alt, #f1f5f9);
  color: var(--vp-c-brand-1, #3b82f6);
}

.session-action-btn.delete-btn:hover {
  background-color: var(--vp-c-danger-soft, rgba(239, 68, 68, 0.1));
  color: var(--vp-c-danger-1, #ef4444);
}

.session-title-input {
  width: 100%;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-1, #1a202c);
  background-color: var(--vp-c-bg, #ffffff);
  border: 1px solid var(--vp-c-brand-1, #3b82f6);
  border-radius: 4px;
  padding: 1px 6px;
  outline: none;
  box-shadow: 0 0 0 2px var(--vp-c-brand-soft, rgba(59, 130, 246, 0.2));
}

/* 底栏 */
.drawer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--vp-c-border, #e2e8f0);
  background-color: var(--vp-c-bg-soft, #f8fafc);
  font-size: 11px;
  color: var(--vp-c-text-3, #94a3b8);
}

.footer-count {
  font-family: var(--vp-font-family-mono, monospace);
}

/* 历史会话三层分级样式 (议题 5) */
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
  color: var(--vp-c-text-3);
  letter-spacing: 0.5px;
}
.category-count {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono, monospace);
}
.session-lec-tag {
  font-size: 10px;
  font-weight: 600;
  font-family: var(--vp-font-family-mono, monospace);
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vp-c-brand-soft, rgba(62, 99, 221, 0.12));
  color: var(--vp-c-brand-1);
  margin-right: 4px;
  flex-shrink: 0;
}
.jump-action-tip {
  font-size: 10.5px;
  color: var(--vp-c-brand-1);
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
