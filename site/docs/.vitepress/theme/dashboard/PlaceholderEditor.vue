<script setup lang="ts">
/**
 * PlaceholderEditor.vue — a text field whose known `{name}` tokens are unbreakable blocks (plan §8, prototype v3 "块编辑器").
 *
 * - drag a block from the palette into the box, or click it to insert at the caret;
 * - typing a known token (`{lecture}`) turns it into a block; an unknown `{xxx}` stays text and is reported;
 * - a block is removed as a whole (Backspace / Delete), pasted text is plain text, Enter is a line break;
 * - the palette sits UNDER the box and shows only while the editor has focus (or right after `{` was typed),
 *   so the box never moves when it is clicked;
 * - read-only: plain text with the blocks as labels and a lock, no editable element at all.
 * The value is always the plain template string (`v-model`).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useT } from '../../i18n/useT.ts'
import type { MessageKey } from '../../i18n/index.ts'
import { segmentTemplate, unknownTokens, type Segment } from './placeholders.ts'
import { say } from './useDashboard'

/** `{name}` as text (a template literal with braces confuses the template parser). */
const brace = (n: string): string => '{' + n + '}'

const props = withDefaults(
  defineProps<{
    modelValue: string
    names: readonly string[]
    label: string
    max?: number
    required?: boolean
    /** Grey example text while the field is empty (never a value). */
    hint?: string
    readonly?: boolean
    small?: boolean
    /** Extra lines under the box (for example the quick-action selection hints). */
    warnings?: readonly string[]
    /** Empty-field text when the field is optional (default: "not filled"). */
    emptyText?: string
    id?: string
  }>(),
  { max: 2000, required: false, hint: '', readonly: false, small: false, warnings: () => [], emptyText: '', id: undefined },
)
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t } = useT()

const box = ref<HTMLDivElement | null>(null)
const focused = ref(false)
const braceTyped = ref(false)
let lastEmitted: string | null = null
let savedRange: Range | null = null
const ZW = '\u200b'

const TOKEN_LABEL: Record<string, MessageKey> = {
  lecture: 'dsh.ph.lecture',
  group: 'dsh.ph.group',
  outline: 'dsh.ph.outline',
  selection: 'dsh.ph.selection',
  lectures: 'dsh.ph.lectures',
}
const tokenLabel = (name: string): string => (TOKEN_LABEL[name] ? t(TOKEN_LABEL[name] as MessageKey) : name)

const unknown = computed(() => unknownTokens(props.modelValue, props.names))
const length = computed(() => props.modelValue.length)
const empty = computed(() => props.modelValue.trim() === '')
const readonlySegments = computed<Segment[]>(() => segmentTemplate(props.modelValue, props.names))

function chipNode(name: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'pe-chip'
  span.contentEditable = 'false'
  span.draggable = true
  span.dataset.ph = name
  span.title = `{${name}}`
  span.textContent = tokenLabel(name)
  return span
}

function render(value: string): void {
  const el = box.value
  if (!el) return
  el.replaceChildren()
  for (const seg of segmentTemplate(value, props.names)) {
    if (seg.kind === 'token') {
      el.append(chipNode(seg.name), document.createTextNode(ZW))
    } else {
      const parts = seg.text.split('\n')
      parts.forEach((p, i) => {
        if (i > 0) el.append(document.createElement('br'))
        if (p) el.append(document.createTextNode(p))
      })
    }
  }
  // a trailing line break needs a second <br> to show the empty last line
  if (value.endsWith('\n')) el.append(document.createElement('br'))
}

/** DOM -> template string. */
function serialize(el: HTMLElement): string {
  let out = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += (n as Text).data
      return
    }
    if (!(n instanceof HTMLElement)) return
    if (n.classList.contains('pe-chip') && n.dataset.ph) {
      out += `{${n.dataset.ph}}`
      return
    }
    if (n.nodeName === 'BR') {
      out += '\n'
      return
    }
    if ((n.nodeName === 'DIV' || n.nodeName === 'P') && out && !out.endsWith('\n')) out += '\n'
    n.childNodes.forEach(walk)
  }
  el.childNodes.forEach(walk)
  return out.split(ZW).join('').replace(/\n$/, '')
}

function emitValue(v: string): void {
  lastEmitted = v
  emit('update:modelValue', v)
}

/** Has a known token been typed as text (outside a block)? */
function hasTypedToken(el: HTMLElement): boolean {
  const re = new RegExp(`\\{(${props.names.join('|')})\\}`)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('.pe-chip')) continue
    if (re.test(node.data)) return true
  }
  return false
}

function caretToEndOfLastChip(): void {
  const el = box.value
  if (!el) return
  const chips = el.querySelectorAll('.pe-chip')
  const last = chips[chips.length - 1]
  const sel = window.getSelection()
  if (!sel) return
  const r = document.createRange()
  if (last?.nextSibling) {
    r.setStart(last.nextSibling, Math.min(1, (last.nextSibling.textContent ?? '').length))
  } else {
    r.selectNodeContents(el)
    r.collapse(false)
  }
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

function onInput(e: Event): void {
  const el = box.value
  if (!el) return
  const ie = e as InputEvent
  if (ie.data === '{') braceTyped.value = true
  if (hasTypedToken(el)) {
    const v = serialize(el)
    render(v)
    caretToEndOfLastChip()
    emitValue(v)
    braceTyped.value = false
    return
  }
  emitValue(serialize(el))
}

const isChip = (n: Node | null | undefined): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('pe-chip')

/**
 * Backspace / Delete next to a block removes the whole block (and its zero-width caret stop) in one key press, as in the
 * prototype's keydown (line 1408). Without this the first Backspace after a typed block only ate the zero-width
 * character behind it (audit #5).
 */
function chipNextToCaret(key: 'Backspace' | 'Delete'): { chip: HTMLElement; zw: Text | null } | null {
  const el = box.value
  const sel = window.getSelection()
  if (!el || !sel || !sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null
  const n = sel.anchorNode
  const o = sel.anchorOffset
  if (key === 'Backspace') {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n as Text
      if (o === 1 && text.data[0] === ZW && isChip(text.previousSibling)) return { chip: text.previousSibling, zw: text }
      if (o === 0 && isChip(text.previousSibling)) return { chip: text.previousSibling, zw: null }
    } else if (n === el && o > 0) {
      const c = el.childNodes[o - 1]
      if (isChip(c)) return { chip: c, zw: null }
    }
    return null
  }
  if (n.nodeType === Node.TEXT_NODE && o === (n as Text).data.length && isChip(n.nextSibling)) {
    const z = n.nextSibling.nextSibling
    return { chip: n.nextSibling, zw: z && z.nodeType === Node.TEXT_NODE && (z as Text).data[0] === ZW ? (z as Text) : null }
  }
  return null
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    document.execCommand('insertLineBreak')
    return
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const hit = chipNextToCaret(e.key)
    if (!hit || !box.value) return
    e.preventDefault()
    const name = hit.chip.dataset.ph ?? ''
    const sel = window.getSelection()
    const r = document.createRange()
    // keep the caret where the block was
    if (hit.chip.previousSibling) r.setStartAfter(hit.chip.previousSibling)
    else r.setStart(box.value, 0)
    hit.chip.remove()
    if (hit.zw) hit.zw.deleteData(0, 1)
    r.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(r)
    emitValue(serialize(box.value))
    say(t('dsh.pe.deleted', { name: tokenLabel(name) }))
  }
}

function onPaste(e: ClipboardEvent): void {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
}

function rememberRange(): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !box.value) return
  const r = sel.getRangeAt(0)
  if (box.value.contains(r.startContainer)) savedRange = r.cloneRange()
}

function insertToken(name: string): void {
  const el = box.value
  if (!el || props.readonly) return
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  if (savedRange && el.contains(savedRange.startContainer)) sel.addRange(savedRange)
  else {
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    sel.addRange(r)
  }
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const chip = chipNode(name)
  const zw = document.createTextNode(ZW)
  range.insertNode(zw)
  range.insertNode(chip)
  const after = document.createRange()
  after.setStart(zw, 1)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)
  savedRange = after.cloneRange()
  emitValue(serialize(el))
}

function onPaletteDragStart(e: DragEvent, name: string): void {
  e.dataTransfer?.setData('text/plain', `{${name}}`)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

function onDrop(e: DragEvent): void {
  const text = e.dataTransfer?.getData('text/plain') ?? ''
  const m = /^\{([A-Za-z_]+)\}$/.exec(text)
  if (!m || !props.names.includes(m[1] as string)) return
  // place the caret at the drop point and insert a block there
  e.preventDefault()
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  const r = doc.caretRangeFromPoint?.(e.clientX, e.clientY)
  if (r && box.value?.contains(r.startContainer)) savedRange = r
  insertToken(m[1] as string)
}

function onFocusOut(e: FocusEvent): void {
  const root = (e.currentTarget as HTMLElement) ?? null
  if (root && e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return
  focused.value = false
  braceTyped.value = false
}

watch(
  () => props.modelValue,
  (v) => {
    if (v === lastEmitted) return
    render(v)
  },
)
watch(
  () => props.readonly,
  async (ro) => {
    if (!ro) {
      await nextTick()
      render(props.modelValue)
    }
  },
)

onMounted(() => {
  if (!props.readonly) render(props.modelValue)
  document.addEventListener('selectionchange', rememberRange)
})
</script>

<template>
  <div v-if="readonly" class="pe-ro" :class="{ empty }" :data-pe-readonly="id ?? ''">
    <span class="db-lock" aria-hidden="true"></span>
    <span v-if="empty" class="db-muted">{{ t('dsh.common.notFilled') }}</span>
    <span v-else class="pe-ro-text"
      ><template v-for="(seg, i) in readonlySegments" :key="i"
        ><span v-if="seg.kind === 'token'" class="pe-tok" :title="`{${seg.name}}`">{{ tokenLabel(seg.name) }}</span
        ><template v-else>{{ seg.text }}</template></template
      ></span
    >
  </div>
  <div
    v-else
    class="pe"
    :class="{ 'is-focused': focused || braceTyped, small }"
    :data-pe="id ?? ''"
    @focusin="focused = true"
    @focusout="onFocusOut"
  >
    <div
      :id="id"
      ref="box"
      class="pe-box"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      :aria-label="label"
      :data-empty="empty ? 'true' : 'false'"
      :data-hint="hint"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @paste="onPaste"
      @drop="onDrop"
      @dragover.prevent
    ></div>
    <div class="pe-pal" role="group" :aria-label="t('dsh.pe.palette')">
      <span class="pe-pal-title">{{ t('dsh.pe.palette') }}</span>
      <button
        v-for="n in names"
        :key="n"
        type="button"
        class="pe-chip pe-pal-chip"
        draggable="true"
        :data-pe-insert="n"
        :title="t('dsh.pe.insertHint')"
        @mousedown.prevent
        @click="insertToken(n)"
        @dragstart="onPaletteDragStart($event, n)"
      >
        {{ tokenLabel(n) }} <code>{{ brace(n) }}</code>
      </button>
      <span class="pe-tip">{{ t('dsh.pe.tip', { token: brace(names[0] ?? '') }) }}</span>
    </div>
    <div class="pe-meta" :data-pe-meta="id ?? ''">
      <span v-for="u in unknown" :key="u" class="db-err" data-pe-unknown>
        <span class="dm" data-k="bad" aria-hidden="true"></span>{{ t('dsh.pe.unknown', { token: brace(u) }) }}
      </span>
      <span v-for="w in warnings" :key="w" class="db-warn"><span class="dm" data-k="warn" aria-hidden="true"></span>{{ w }}</span>
      <span v-if="empty && required" class="db-err"><span class="dm" data-k="bad" aria-hidden="true"></span>{{ t('dsh.common.requiredEmpty') }}</span>
      <span v-else-if="empty" class="db-muted"><span class="dm" data-k="off" aria-hidden="true"></span>{{ emptyText || t('dsh.common.notFilled') }}</span>
      <span v-if="length > max" class="db-err" data-pe-over><span class="dm" data-k="bad" aria-hidden="true"></span>{{ t('dsh.common.overLimit') }}</span>
      <span class="pe-count" :class="{ 'db-err': length > max }">{{ length }} / {{ max }}</span>
    </div>
  </div>
</template>
