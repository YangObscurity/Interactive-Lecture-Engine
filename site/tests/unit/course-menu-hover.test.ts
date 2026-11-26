// @vitest-environment happy-dom
/**
 * Unit tests for NavCourseMenu desktop hover open / close controller and skin wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import {
  COURSE_MENU_HOVER_CLOSE_DELAY_MS,
  COURSE_MENU_TOUCH_GUARD_MS,
  createCourseMenuHoverController,
  type CourseMenuOpenMode,
} from '../../docs/.vitepress/theme/core/courseMenuHover.ts'
import DefaultNavCourseMenu from '../../docs/.vitepress/theme/slots/default/NavCourseMenu.vue'
import DatasheetNavCourseMenu from '../../docs/.vitepress/themes/datasheet/components/NavCourseMenu.vue'
import type { CourseMenuGroupView, NavCourseMenuProps } from '../../docs/.vitepress/theme/slots/registry.ts'

function sampleGroups(): CourseMenuGroupView[] {
  return [
    {
      id: 'PLN',
      title: 'Planning',
      catSlot: 0,
      category: 'Foundations',
      href: '/pln/',
      read: 1,
      total: 2,
      isCurrent: true,
      lectures: [
        {
          id: 'pln-l01',
          no: '01',
          title: 'Intro',
          href: '/pln/L01',
          status: 'read',
          isCurrent: true,
          ariaLabel: '01 Intro',
        },
      ],
    },
    {
      id: 'MEA',
      title: 'Measurement',
      catSlot: 1,
      category: 'Methods',
      href: '/mea/',
      read: 0,
      total: 1,
      isCurrent: false,
      lectures: [],
    },
  ]
}

function makeProps(overrides: Partial<NavCourseMenuProps> = {}): NavCourseMenuProps {
  const groups = sampleGroups()
  return {
    isOpen: false,
    isMobile: false,
    groups,
    activeGroupId: 'PLN',
    activeGroup: groups[0] ?? null,
    activeLectureIndex: -1,
    activeColumn: 'groups',
    expandedGroupIds: [],
    labels: {
      groups: 'Groups',
      dialogLabel: 'Course groups',
      enterGroup: 'Enter group',
      readCount: 'Completed',
      readSuffix: 'lectures',
      hintSelectGroup: 'select',
      hintEnterLectures: 'lectures',
      hintOpen: 'open',
      hintClose: 'close',
      expandGroup: 'expand',
      collapseGroup: 'collapse',
    },
    openMode: null,
    onToggle: vi.fn(),
    onClose: vi.fn(),
    onHoverEnter: vi.fn(),
    onHoverLeave: vi.fn(),
    onSelectGroup: vi.fn(),
    onToggleGroupExpand: vi.fn(),
    onOpenGroup: vi.fn(),
    onOpenLecture: vi.fn(),
    onKeyDown: vi.fn(),
    ...overrides,
  }
}

describe('createCourseMenuHoverController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens immediately on hover and closes after leave delay unless re-entered', () => {
    let open = false
    let mode: CourseMenuOpenMode | null = null
    const ctrl = createCourseMenuHoverController({
      isOpen: () => open,
      getMode: () => mode,
      openHover: () => {
        open = true
        mode = 'hover'
      },
      closeHover: () => {
        open = false
        mode = null
      },
    })

    ctrl.onHoverEnter()
    expect(open).toBe(true)
    expect(mode).toBe('hover')

    ctrl.onHoverLeave()
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS - 20)
    expect(open).toBe(true)

    // Moving cursor back onto panel cancels pending close
    ctrl.onHoverEnter()
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS)
    expect(open).toBe(true)

    // Leaving completely closes after full grace delay
    ctrl.onHoverLeave()
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS)
    expect(open).toBe(false)
    expect(mode).toBeNull()
  })

  it('does not auto-close on leave once promoted to explicit mode', () => {
    let open = false
    let mode: CourseMenuOpenMode | null = null
    const ctrl = createCourseMenuHoverController({
      isOpen: () => open,
      getMode: () => mode,
      openHover: () => {
        open = true
        mode = 'hover'
      },
      closeHover: () => {
        open = false
        mode = null
      },
    })

    ctrl.onHoverEnter()
    expect(open).toBe(true)
    mode = 'explicit'
    ctrl.onHoverLeave()
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS * 2)
    expect(open).toBe(true)
  })

  it('suppresses touch pointer events and synthetic mouseenter fallback during touch guard window', () => {
    let clock = 1_000
    let open = false
    let mode: CourseMenuOpenMode | null = null
    const ctrl = createCourseMenuHoverController({
      now: () => clock,
      isOpen: () => open,
      getMode: () => mode,
      openHover: () => {
        open = true
        mode = 'hover'
      },
      closeHover: () => {
        open = false
        mode = null
      },
    })

    ctrl.onHoverEnter({ pointerType: 'touch' } as unknown as Event)
    expect(open).toBe(false)

    // Compatibility mouseenter emitted immediately after touch tap stays blocked
    clock += 20
    ctrl.onHoverEnter({ type: 'mouseenter' } as unknown as Event)
    expect(open).toBe(false)

    // Real mouse pointer overrides touch guard cleanly; after guard expires generic events also work
    clock += COURSE_MENU_TOUCH_GUARD_MS + 10
    ctrl.onHoverEnter({ pointerType: 'mouse' } as unknown as Event)
    expect(open).toBe(true)
  })

  it('ignores mobile invocations and clears pending timers cleanly', () => {
    let mobile = true
    let open = false
    let mode: CourseMenuOpenMode | null = null
    const ctrl = createCourseMenuHoverController({
      isMobile: () => mobile,
      isOpen: () => open,
      getMode: () => mode,
      openHover: () => {
        open = true
        mode = 'hover'
      },
      closeHover: () => {
        open = false
        mode = null
      },
    })

    ctrl.onHoverEnter()
    expect(open).toBe(false)

    mobile = false
    ctrl.onHoverEnter()
    expect(open).toBe(true)
    ctrl.onHoverLeave()
    ctrl.clearTimer()
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS * 2)
    expect(open).toBe(true)
  })

  it('keeps hover-opened menu open while focus is inside the panel and closes once both hover and focus leave', () => {
    let open = false
    let mode: CourseMenuOpenMode | null = null
    let focusedInside = false
    const ctrl = createCourseMenuHoverController({
      isOpen: () => open,
      getMode: () => mode,
      hasFocusWithin: () => focusedInside,
      openHover: () => {
        open = true
        mode = 'hover'
      },
      closeHover: () => {
        open = false
        mode = null
      },
    })

    ctrl.onHoverEnter()
    expect(open).toBe(true)

    // Keyboard user tabs into the panel before pointer moves away
    focusedInside = true
    ctrl.onFocusIn()
    ctrl.onHoverLeave()
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS * 2)
    expect(open).toBe(true)

    // Moving focus out of the panel while pointer is already outside closes after delay
    focusedInside = false
    ctrl.onFocusOut(false)
    vi.advanceTimersByTime(COURSE_MENU_HOVER_CLOSE_DELAY_MS)
    expect(open).toBe(false)
  })
})

describe.each([
  ['default', DefaultNavCourseMenu],
  ['datasheet', DatasheetNavCourseMenu],
])('NavCourseMenu (%s skin) hover wiring', (_name, Component) => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('forwards mouseenter/mouseleave on desktop and suppresses hover on mobile', async () => {
    const onHoverEnter = vi.fn()
    const onHoverLeave = vi.fn()
    const wrapper = mount(Component, {
      props: makeProps({ onHoverEnter, onHoverLeave }),
    })

    await wrapper.find('.cm-wrap').trigger('mouseenter')
    await wrapper.find('.cm-wrap').trigger('mouseleave')
    expect(onHoverEnter).toHaveBeenCalledTimes(1)
    expect(onHoverLeave).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ isMobile: true })
    await wrapper.find('.cm-wrap').trigger('mouseenter')
    await wrapper.find('.cm-wrap').trigger('mouseleave')
    expect(onHoverEnter).toHaveBeenCalledTimes(1)
    expect(onHoverLeave).toHaveBeenCalledTimes(1)
  })

  it('avoids stealing focus when opened by hover, and focuses group item once promoted explicit', async () => {
    const externalInput = document.createElement('input')
    document.body.appendChild(externalInput)
    externalInput.focus()
    expect(document.activeElement).toBe(externalInput)

    const wrapper = mount(Component, {
      attachTo: document.body,
      props: makeProps({ isOpen: false, openMode: null }),
    })

    await wrapper.setProps({ isOpen: true, openMode: 'hover' })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(externalInput)

    // Hovering another group previews without yanking focus away
    await wrapper.setProps({ activeGroupId: 'MEA' })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(externalInput)

    // Promoting to explicit focus-activates the active group link
    await wrapper.setProps({ openMode: 'explicit' })
    await nextTick()
    await nextTick()
    expect(document.activeElement?.closest('.cm-groups')).not.toBeNull()

    wrapper.unmount()
  })
})
