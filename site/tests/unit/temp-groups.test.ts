// @vitest-environment happy-dom
/**
 * Unit & component tests for formal Temporary Groups (`temp: true`):
 *   - Home cards (`reader` & `datasheet` GroupCard) render temp badge only when `temp: true`
 *   - NavCourseMenu (`reader` & `datasheet`, desktop & mobile) renders temp badge for temporary groups
 *   - GroupTitleBlock renders temp badge + hint note for temporary groups
 *   - LectureProgressCard suppresses Notion sync controls & error states on temporary groups and shows honest DB/local status
 *   - notionSync treats HTTP 501 as non-retryable
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'

const vpLang = ref('zh-CN')
const vpPath = ref('/tmp/L06')
const vpPage = ref({ title: 'Lecture 06 · Topic' })
const vpFrontmatter = ref<Record<string, unknown>>({})
const vpTheme = ref<Record<string, unknown>>({
  groups: [
    { id: 'G01', dir: 'g01', title: '常规课程组' },
    { id: 'TMP', dir: 'tmp', title: 'Synthetic temp group', temp: true },
  ],
  lectureModules: {
    progress: { adapter: 'rest', endpoint: '/api/db', notionSync: true },
    auth: { adapter: 'trusted-header', sessionEndpoint: '/api/auth/session' },
  },
})
const vpSite = ref({ base: '/' })

const mockSession = ref({
  status: 'authenticated',
  user: { id: 'admin-1', displayName: 'Admin' },
  roles: ['admin'],
})

const mockStatuses = ref<Record<string, 'not_started' | 'in_progress' | 'completed'>>({})
const mockSet = vi.fn((id: string, status: 'not_started' | 'in_progress' | 'completed') => {
  mockStatuses.value[id] = status
})

vi.mock('vitepress', () => ({
  useData: () => ({
    lang: vpLang,
    page: vpPage,
    frontmatter: vpFrontmatter,
    theme: vpTheme,
    site: vpSite,
  }),
  useRoute: () => ({
    get path() {
      return vpPath.value
    },
    get data() {
      return { frontmatter: vpFrontmatter.value }
    },
  }),
  withBase: (p: string) => p,
}))

vi.mock('../../docs/.vitepress/theme/auth/useSession', () => ({
  useSession: () => computed(() => mockSession.value),
}))

vi.mock('../../docs/.vitepress/theme/auth/session', () => ({
  currentSession: () => mockSession.value,
  getSession: async () => mockSession.value,
  subscribeSession: () => () => undefined,
}))

vi.mock('../../docs/.vitepress/theme/progress/useProgress', () => ({
  useProgress: () => ({
    ready: ref(true),
    statusOf: (id: string) => mockStatuses.value[id] ?? 'not_started',
    completedAtOf: (id: string) => (mockStatuses.value[id] === 'completed' ? '2026-11-26T00:00:00.000Z' : null),
    countCompleted: () => 0,
    set: mockSet,
    setMany: () => undefined,
    syncState: ref('idle'),
    pending: ref(0),
    onRejected: () => () => undefined,
  }),
}))

import DefaultGroupCard from '../../docs/.vitepress/theme/slots/default/GroupCard.vue'
import DatasheetGroupCard from '../../docs/.vitepress/themes/datasheet/components/GroupCard.vue'
import DefaultNavCourseMenu from '../../docs/.vitepress/theme/slots/default/NavCourseMenu.vue'
import DatasheetNavCourseMenu from '../../docs/.vitepress/themes/datasheet/components/NavCourseMenu.vue'
import GroupTitleBlock from '../../docs/.vitepress/theme/group/GroupTitleBlock.vue'
import LectureProgressCard from '../../docs/.vitepress/theme/components/ai/LectureProgressCard.vue'
import * as notionSync from '../../docs/.vitepress/theme/components/ai/notionSync'

const BASE_CARD_PROPS = {
  id: 'TMP',
  href: '/tmp/',
  category: 'Demo',
  slot: 1,
  title: 'Synthetic review',
  tagline: 'Synthetic topic',
  summary: '临时专题整理',
  tags: ['DEMO'],
  total: 6,
  read: 2,
  reading: 1,
  ticks: 'rrguuu',
  pkg: 'SOIC-6',
  next: { kind: 'reading' as const, heading: '继续', title: 'L03' },
  labels: {
    lectures: '6 讲',
    read: '2 / 6 已读',
    readHeading: '已读',
    lecturesHeading: '讲数',
    tagsHeading: '标签',
    tagsSeparator: ' · ',
    enter: '进入',
  },
}

const MENU_GROUPS = [
  {
    id: 'G01',
    title: '常规组',
    href: '/g01/',
    catSlot: 1,
    category: '基础',
    read: 1,
    total: 4,
    isCurrent: false,
    lectures: [{ id: 'g01-l01', no: '01', title: '第一讲', href: '/g01/L01', status: 'read' as const, isCurrent: false, ariaLabel: 'L01' }],
  },
  {
    id: 'TMP',
    title: 'Synthetic temp group',
    href: '/tmp/',
    catSlot: 2,
    category: 'Temp',
    read: 0,
    total: 6,
    isCurrent: true,
    temp: true,
    lectures: [{ id: 'tmp-l06', no: '06', title: 'Topic', href: '/tmp/L06', status: 'unread' as const, isCurrent: true, ariaLabel: 'L06' }],
  },
]

const MENU_LABELS = {
  groups: '课程组',
  dialogLabel: '课程菜单',
  enterGroup: '进入组页',
  readCount: '0 / 6 已读',
  readSuffix: '已读',
  hintSelectGroup: '选组',
  hintEnterLectures: '进讲',
  hintOpen: '打开',
  hintClose: '关闭',
  expandGroup: '展开',
  collapseGroup: '收起',
  temp: '临时',
}

describe('formal temporary group UI', () => {
  beforeEach(() => {
    vpLang.value = 'zh-CN'
    vpPath.value = '/tmp/L06'
    vpFrontmatter.value = {}
    vpTheme.value = {
      groups: [
        { id: 'G01', dir: 'g01', title: '常规课程组' },
        { id: 'TMP', dir: 'tmp', title: 'Synthetic temp group', temp: true },
      ],
      lectureModules: {
        progress: { adapter: 'rest', endpoint: '/api/db', notionSync: true },
        auth: { adapter: 'trusted-header', sessionEndpoint: '/api/auth/session' },
      },
    }
    mockSession.value = {
      status: 'authenticated',
      user: { id: 'admin-1', displayName: 'Admin' },
      roles: ['admin'],
    }
    mockStatuses.value = {}
    mockSet.mockClear()
    notionSync.clearFailedQueue()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders temporary badge in both reader and datasheet GroupCard when temp is true', () => {
    for (const Card of [DefaultGroupCard, DatasheetGroupCard]) {
      const wTemp = mount(Card, { props: { ...BASE_CARD_PROPS, temp: true, tempLabel: '临时' } })
      expect(wTemp.find('[data-temp-badge]').exists()).toBe(true)
      expect(wTemp.find('[data-temp-badge]').text()).toBe('临时')

      const wPerm = mount(Card, { props: BASE_CARD_PROPS })
      expect(wPerm.find('[data-temp-badge]').exists()).toBe(false)
    }
  })

  it('renders temporary badge in desktop and mobile NavCourseMenu across both skins', () => {
    for (const Menu of [DefaultNavCourseMenu, DatasheetNavCourseMenu]) {
      const desktop = mount(Menu, {
        props: {
          isOpen: true,
          isMobile: false,
          groups: MENU_GROUPS,
          activeGroupId: 'TMP',
          activeGroup: MENU_GROUPS[1] ?? null,
          activeLectureIndex: -1,
          activeColumn: 'groups' as const,
          expandedGroupIds: [],
          labels: MENU_LABELS,
          onToggle: () => undefined,
          onClose: () => undefined,
          onSelectGroup: () => undefined,
          onToggleGroupExpand: () => undefined,
          onOpenGroup: () => undefined,
          onOpenLecture: () => undefined,
          onKeyDown: () => undefined,
        },
      })
      const badges = desktop.findAll('[data-temp-badge]')
      expect(badges.length).toBe(2) // TMP group row + active TMP header
      expect(desktop.find('.cm-groups a[href="/g01/"] [data-temp-badge]').exists()).toBe(false)

      const mobile = mount(Menu, {
        props: {
          isOpen: true,
          isMobile: true,
          groups: MENU_GROUPS,
          activeGroupId: 'TMP',
          activeGroup: MENU_GROUPS[1] ?? null,
          activeLectureIndex: -1,
          activeColumn: 'groups' as const,
          expandedGroupIds: [],
          labels: MENU_LABELS,
          onToggle: () => undefined,
          onClose: () => undefined,
          onSelectGroup: () => undefined,
          onToggleGroupExpand: () => undefined,
          onOpenGroup: () => undefined,
          onOpenLecture: () => undefined,
          onKeyDown: () => undefined,
        },
      })
      expect(mobile.findAll('[data-temp-badge]').length).toBe(1)
    }
  })

  it('renders temporary badge and DB/local hint in GroupTitleBlock only when temp is true', () => {
    const baseProps = {
      id: 'TMP',
      category: 'Demo',
      catSlot: 1,
      title: 'Synthetic review',
      tagline: '线型整理',
      summary: '摘要',
      tags: ['DEMO'],
      lectureCount: 6,
      stages: 0,
      chartCount: 0,
      read: 1,
      reading: 0,
      ready: 0,
      translated: '',
      pre: [],
      post: [],
      prefix: '',
      cta: { kind: 'start' as const, href: '/tmp/L01', label: '开始学习', pct: '', startHref: '/tmp/L01', startLabel: '开始学习' },
      notionLang: '',
    }

    const wTemp = mount(GroupTitleBlock, { props: { ...baseProps, temp: true } })
    expect(wTemp.find('[data-temp-badge]').text()).toBe('临时')
    expect(wTemp.find('[data-gp-temp-note]').exists()).toBe(true)

    const wPerm = mount(GroupTitleBlock, { props: baseProps })
    expect(wPerm.find('[data-temp-badge]').exists()).toBe(false)
    expect(wPerm.find('[data-gp-temp-note]').exists()).toBe(false)
  })

  it('shows honest DB/local-only footer on temporary group LectureProgressCard and hides Notion sync errors', async () => {
    const mountCard = async () => {
      const w = mount(LectureProgressCard, {
        global: { stubs: { Teleport: true } },
      })
      await nextTick()
      return w
    }

    const wRest = await mountCard()
    expect(wRest.find('[data-lpc-temp-badge]').exists()).toBe(true)
    expect(wRest.find('[data-lpc-temp-progress]').text()).toContain('存入数据库并缓存在本地')
    expect(wRest.find('[data-lpc-notion-control]').exists()).toBe(false)

    // Clicking progress triggers progressStore write cleanly without Notion controls appearing
    await wRest.find('.lpc-primary-btn').trigger('click')
    expect(mockSet).toHaveBeenCalledWith('tmp-L06', 'completed', { groupId: 'tmp' })
    expect(wRest.find('[data-lpc-notion-error]').exists()).toBe(false)
    wRest.unmount()

    // Restricted temporary lecture page before access slice merges (via fm.groupTemp) in local adapter mode
    vpPath.value = '/rtmp/L02'
    vpFrontmatter.value = { groupTemp: true }
    vpPage.value = { title: '第02讲 · 受限临时', frontmatter: vpFrontmatter.value } as typeof vpPage.value & { frontmatter: Record<string, unknown> }
    vpTheme.value = {
      groups: [{ id: 'G01', dir: 'g01', title: '常规课程组' }],
      lectureModules: { progress: { adapter: 'local', notionSync: true } },
    }
    const wLocal = await mountCard()
    expect(wLocal.find('[data-lpc-temp-badge]').exists()).toBe(true)
    expect(wLocal.find('[data-lpc-temp-progress]').text()).toContain('仅保存在本地浏览器')
    expect(wLocal.find('[data-lpc-notion-control]').exists()).toBe(false)
    wLocal.unmount()

    // Restricted group index page carrying fm.groupMeta.temp === true
    vpFrontmatter.value = { groupMeta: { id: 'RTMP', dir: 'rtmp', temp: true } }
    vpPage.value = { title: '受限临时组', frontmatter: vpFrontmatter.value } as typeof vpPage.value & { frontmatter: Record<string, unknown> }
    const wMeta = await mountCard()
    expect(wMeta.find('[data-lpc-temp-badge]').exists()).toBe(true)
    expect(wMeta.find('[data-lpc-notion-control]').exists()).toBe(false)
    wMeta.unmount()

    // Permanent group still displays Notion sync control for admin
    vpPath.value = '/g01/L01'
    vpFrontmatter.value = {}
    vpTheme.value = {
      groups: [{ id: 'G01', dir: 'g01', title: '常规课程组' }],
      lectureModules: { progress: { adapter: 'rest', notionSync: true } },
    }
    const wPerm = await mountCard()
    expect(wPerm.find('[data-lpc-temp-badge]').exists()).toBe(false)
    expect(wPerm.find('[data-lpc-temp-progress]').exists()).toBe(false)
    expect(wPerm.find('[data-lpc-notion-control]').exists()).toBe(true)
    wPerm.unmount()
  })

  it('does not retry HTTP 501 responses in notionSync', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/progress/notion-sync')) {
        return new Response(JSON.stringify({ code: 404 }), { status: 404 })
      }
      return new Response('Unsupported method', { status: 501 })
    })
    vi.stubGlobal('fetch', fetchMock)

    notionSync.syncStatusToNotion('g01-l01', '已完成')
    await vi.waitFor(() => {
      const stats = notionSync.getNotionQueueStats()
      expect(stats.totalFailed).toBe(1)
      expect(stats.processing).toBe(false)
    })

    expect(notionSync.getNotionQueueStats().totalRetried).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
