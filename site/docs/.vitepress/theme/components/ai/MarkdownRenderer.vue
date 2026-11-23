<script setup lang="ts">
/**
 * MarkdownRenderer.vue — AI 伴读消息高保真 Markdown / KaTeX / Shiki 渲染组件
 * 
 * 职责：
 *   1. 响应式解析并渲染 AI 伴读消息 Markdown 正文；
 *   2. 精准渲染数学公式：
 *      - 行内公式 \(...\) 与 $...$：KaTeX 矢量渲染；
 *      - 行间公式 $$...$$ 与 \[...\]：KaTeX 独立块矢量渲染，支持超宽横向滚动；
 *      - 公式支持点击或独立按钮一键复制 LaTeX 源码；
 *   3. 深度集成 Shiki 语法高亮：
 *      - 支持 C, C++, ASM, Python, Bash, Shell, JSON, TS, JS, HTML, CSS 等工程语言；
 *      - 包含语言识别徽章与纯工程风一键复制代码按钮；
 *      - 深度适配 VitePress 深浅色主题 CSS 变量（--vp-c-* 与 --vp-code-*）；
 *   4. XSS 安全防护：DOMPurify 严格过滤危险脚本与注入，白名单放行 MathML、SVG 与工程样式；
 *   5. SSR 预渲染安全守卫：服务端渲染零异常，客户端挂载平滑注水。
 * 
 * 铁律：
 *   - 零 Emoji 铁律：全组件严禁任何 Emoji 字符，一律采用纯工程矢量 SVG；
 *   - 严格类型守恒：严密 TypeScript 接口定义；
 *   - 内存与生命周期安全：计时器及时清理，事件采用根容器委托，杜绝内存泄漏。
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Marked } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { createHighlighter, type Highlighter } from 'shiki'
import { currentLang, translate } from '../../../i18n/index.ts'
import { ICONS } from './icons'
import { resolveDomPurifyInstance, sanitizeHtmlFailClosed } from './markdownSanitize'

interface Props {
  /** 待渲染的 Markdown 源码 */
  content: string
  /** 是否处于流式传输中 */
  isStreaming?: boolean
  /** 自定义根容器附加类名 */
  customClass?: string
}

const props = withDefaults(defineProps<Props>(), {
  content: '',
  isStreaming: false,
  customClass: ''
})

const emit = defineEmits<{
  (e: 'copied', payload: { type: 'code' | 'tex'; text: string }): void
}>()

const isMounted = ref(false)
const highlighterReady = ref(false)
const rootContainerRef = ref<HTMLElement | null>(null)
const displayedContent = ref(props.content)

const STREAM_RENDER_THROTTLE_MS = 60
let streamThrottleTimer: ReturnType<typeof setTimeout> | null = null
let lastStreamRenderAt = 0

function clearStreamThrottleTimer() {
  if (streamThrottleTimer !== null) {
    clearTimeout(streamThrottleTimer)
    streamThrottleTimer = null
  }
}

watch(
  [() => props.content, () => props.isStreaming],
  ([nextContent, streaming]) => {
    if (!streaming) {
      clearStreamThrottleTimer()
      displayedContent.value = nextContent
      lastStreamRenderAt = Date.now()
      return
    }
    const now = Date.now()
    const elapsed = now - lastStreamRenderAt
    if (elapsed >= STREAM_RENDER_THROTTLE_MS) {
      clearStreamThrottleTimer()
      displayedContent.value = nextContent
      lastStreamRenderAt = now
    } else if (streamThrottleTimer === null) {
      streamThrottleTimer = setTimeout(() => {
        streamThrottleTimer = null
        displayedContent.value = props.content
        lastStreamRenderAt = Date.now()
      }, STREAM_RENDER_THROTTLE_MS - elapsed)
    }
  }
)

/** 活跃的复制反馈计时器集合，组件卸载时统一销毁 */
const activeTimers = new Set<ReturnType<typeof setTimeout>>()

/**
 * 字符转义工具，防止属性注入
 */
function escapeAttr(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 语言别名规范化映射
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'shellsession': 'bash',
  'assembly': 'asm',
  'nasm': 'asm',
  'gas': 'asm',
  'arm': 'asm',
  'yml': 'yaml',
  'jsonc': 'json'
}

/**
 * Shiki 单例高亮器调度器
 */
let sharedHighlighterPromise: Promise<Highlighter | null> | null = null
let sharedHighlighter: Highlighter | null = null
const highlightCache = new Map<string, string>()
const MAX_CACHE_SIZE = 256

async function getOrCreateHighlighter(): Promise<Highlighter | null> {
  if (sharedHighlighter) return sharedHighlighter
  if (sharedHighlighterPromise) return sharedHighlighterPromise

  sharedHighlighterPromise = (async () => {
    try {
      const highlighter = await createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: [
          'c', 'cpp', 'asm', 'python', 'bash', 'sh', 'shell',
          'json', 'javascript', 'typescript', 'html', 'css',
          'markdown', 'yaml', 'text', 'ini', 'sql'
        ]
      })
      sharedHighlighter = highlighter
      return highlighter
    } catch {
      return null
    }
  })()

  return sharedHighlighterPromise
}

/**
 * 代码语法高亮调度
 */
function renderCodeHighlight(code: string, rawLang: string): string {
  const norm = (rawLang || '').trim().toLowerCase()
  const langKey = LANGUAGE_ALIASES[norm] || norm || 'text'
  const cacheKey = `${langKey}:::${code}`

  if (highlightCache.has(cacheKey)) {
    return highlightCache.get(cacheKey)!
  }

  let htmlResult = ''
  if (sharedHighlighter) {
    try {
      const loadedLangs = sharedHighlighter.getLoadedLanguages()
      const targetLang = loadedLangs.includes(langKey) ? langKey : 'text'
      htmlResult = sharedHighlighter.codeToHtml(code, {
        lang: targetLang,
        themes: {
          light: 'github-light',
          dark: 'github-dark'
        }
      })
    } catch {
      htmlResult = `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`
    }
  } else {
    htmlResult = `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`
  }

  if (highlightCache.size >= MAX_CACHE_SIZE) {
    const firstKey = highlightCache.keys().next().value
    if (firstKey) highlightCache.delete(firstKey)
  }
  highlightCache.set(cacheKey, htmlResult)
  return htmlResult
}

/**
 * 封装 KaTeX 渲染
 */
function renderLatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      errorColor: 'currentColor',
      strict: false,
      output: 'htmlAndMathml'
    })
  } catch {
    return `<span class="katex-fallback">${escapeHtml(tex)}</span>`
  }
}

/**
 * Marked 扩展配置
 */
function buildMarkedInstance(): Marked {
  const marked = new Marked({
    gfm: true,
    breaks: true
  })

  // 行间数学公式扩展：$$...$$ 与 \[...\]
  const mathBlockExtension = {
    name: 'mathBlock',
    level: 'block' as const,
    start(src: string) {
      const i1 = src.indexOf('$$')
      const i2 = src.indexOf('\\[')
      if (i1 === -1) return i2
      if (i2 === -1) return i1
      return Math.min(i1, i2)
    },
    tokenizer(src: string) {
      const match = /^(\$\$|\\\[)([\s\S]*?)(\$\$|\\\])/.exec(src)
      if (match) {
        return {
          type: 'mathBlock',
          raw: match[0],
          text: match[2].trim()
        }
      }
    },
    renderer(token: { text: string }) {
      const tex = token.text
      const rendered = renderLatex(tex, true)
      const lang = currentLang()
      const copyTitle = escapeAttr(translate(lang, 'ai.copyLatexBtnTitle'))
      const copyLabel = escapeHtml(translate(lang, 'ai.copy'))
      const clickTitle = escapeAttr(translate(lang, 'ai.clickCopyLatexTitle'))
      return `<div class="ai-math-block-container">\n` +
        `  <div class="ai-math-toolbar">\n` +
        `    <span class="ai-math-tag">LaTeX</span>\n` +
        `    <button type="button" class="ai-math-copy-btn" data-tex="${escapeAttr(tex)}" title="${copyTitle}">\n` +
        `      <span class="btn-icon">${ICONS.copy}</span>\n` +
        `      <span class="btn-text">${copyLabel}</span>\n` +
        `    </button>\n` +
        `  </div>\n` +
        `  <div class="math-node math-block" data-tex="${escapeAttr(tex)}" title="${clickTitle}">${rendered}</div>\n` +
        `</div>\n`
    }
  }

  // 行内数学公式扩展：\(...\) 与 $...$
  const mathInlineExtension = {
    name: 'mathInline',
    level: 'inline' as const,
    start(src: string) {
      const i1 = src.indexOf('\\(')
      const i2 = src.indexOf('$')
      if (i1 === -1) return i2
      if (i2 === -1) return i1
      return Math.min(i1, i2)
    },
    tokenizer(src: string) {
      // 优先匹配 \(...\)
      const matchParen = /^\\\(([\s\S]*?)\\\)/.exec(src)
      if (matchParen) {
        return {
          type: 'mathInline',
          raw: matchParen[0],
          text: matchParen[1].trim()
        }
      }
      // 次选匹配 $...$（排除 $$ 以及价格货币符号 $100）
      const matchDollar = /^\$(?!\s)([^$\n]+?)(?<!\s|\$)\$(?!\d)/.exec(src)
      if (matchDollar) {
        return {
          type: 'mathInline',
          raw: matchDollar[0],
          text: matchDollar[1].trim()
        }
      }
    },
    renderer(token: { text: string }) {
      const tex = token.text
      const rendered = renderLatex(tex, false)
      const clickTitle = escapeAttr(translate(currentLang(), 'ai.clickCopyLatexTitle'))
      return `<span class="math-node math-inline" data-tex="${escapeAttr(tex)}" title="${clickTitle}">${rendered}</span>`
    }
  }

  marked.use({
    extensions: [mathBlockExtension, mathInlineExtension],
    renderer: {
      code(tokenOrText: string | { text?: string; lang?: string }, langStr?: string) {
        const text = typeof tokenOrText === 'string' ? tokenOrText : (tokenOrText?.text ?? '')
        const rawLang = typeof tokenOrText === 'string' ? langStr : (tokenOrText?.lang ?? '')
        const lang = (rawLang || '').trim().split(/\s+/)[0].toLowerCase() || 'text'
        const badgeText = (rawLang || 'TEXT').trim().split(/\s+/)[0].toUpperCase()
        const highlighted = renderCodeHighlight(text, lang)
        const locale = currentLang()
        const copyTitle = escapeAttr(translate(locale, 'ai.copyCodeTitle'))
        const copyLabel = escapeHtml(translate(locale, 'ai.copy'))

        return `<div class="ai-code-block language-${escapeAttr(lang)}">\n` +
          `  <div class="ai-code-header">\n` +
          `    <span class="ai-code-lang">${escapeHtml(badgeText)}</span>\n` +
          `    <button type="button" class="ai-code-copy-btn" data-code="${escapeAttr(text)}" title="${copyTitle}">\n` +
          `      <span class="btn-icon">${ICONS.copy}</span>\n` +
          `      <span class="btn-text">${copyLabel}</span>\n` +
          `    </button>\n` +
          `  </div>\n` +
          `  <div class="ai-code-body">${highlighted}</div>\n` +
          `</div>\n`
      }
    }
  })

  return marked
}

const parser = buildMarkedInstance()

/**
 * XSS 安全清洗过滤（fail-closed，禁止 style 属性注入、禁止 img、强制 rel="noopener noreferrer"）
 */
function sanitizeHtmlSafe(rawHtml: string): string {
  const win = typeof window !== 'undefined' ? window : null
  return sanitizeHtmlFailClosed(rawHtml, resolveDomPurifyInstance(DOMPurify, win))
}

/**
 * 响应式计算最终渲染 HTML
 */
const renderedHtml = computed(() => {
  // 依赖 isMounted 与 highlighterReady 确保客户端挂载和高亮器就绪后自动重算
  void isMounted.value
  void highlighterReady.value

  let raw = displayedContent.value
  if (!raw || !raw.trim()) {
    return ''
  }

  const locale = currentLang()
  raw = raw
    .replace(/\{\{\s*current_lecture\s*\}\}/gi, translate(locale, 'ai.globalContextName'))
    .replace(/\{\{\s*group\s*\}\}/gi, translate(locale, 'ai.globalGroupName'))
    .replace(/\{\{\s*outline\s*\}\}/gi, translate(locale, 'ai.globalOutlineName'))
    .replace(/\{\{\s*selection\s*\}\}/gi, translate(locale, 'ai.noSelection'))

  try {
    const rawParsed = parser.parse(raw) as string
    return sanitizeHtmlSafe(rawParsed)
  } catch {
    return `<p class="render-error">${escapeHtml(raw)}</p>`
  }
})

/**
 * 剪贴板写入安全降级实现
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  if (typeof window === 'undefined') return false

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 降级兜底方案
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch {
    return false
  }
}

/**
 * 更新按钮的复制成功状态并在 1500ms 后自动复原
 */
function triggerButtonFeedback(btn: HTMLButtonElement, successText: string, originalText: string) {
  btn.classList.add('copied')
  const iconSpan = btn.querySelector('.btn-icon')
  const textSpan = btn.querySelector('.btn-text')

  if (iconSpan) iconSpan.innerHTML = ICONS.check
  if (textSpan) textSpan.textContent = successText

  const timer = setTimeout(() => {
    btn.classList.remove('copied')
    if (iconSpan) iconSpan.innerHTML = ICONS.copy
    if (textSpan) textSpan.textContent = originalText
    activeTimers.delete(timer)
  }, 1500)

  activeTimers.add(timer)
}

/**
 * 根容器事件委托处理所有复制点击
 */
const handleContainerClick = async (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  if (!target) return

  // 1. 代码块复制按钮
  const codeBtn = target.closest('.ai-code-copy-btn') as HTMLButtonElement | null
  if (codeBtn) {
    event.preventDefault()
    event.stopPropagation()
    const code = codeBtn.dataset.code || ''
    if (code) {
      const ok = await copyToClipboard(code)
      if (ok) {
        const locale = currentLang()
        triggerButtonFeedback(codeBtn, translate(locale, 'ai.copied'), translate(locale, 'ai.copy'))
        emit('copied', { type: 'code', text: code })
      }
    }
    return
  }

  // 2. 公式块复制按钮
  const mathBtn = target.closest('.ai-math-copy-btn') as HTMLButtonElement | null
  if (mathBtn) {
    event.preventDefault()
    event.stopPropagation()
    const tex = mathBtn.dataset.tex || ''
    if (tex) {
      const ok = await copyToClipboard(tex)
      if (ok) {
        const locale = currentLang()
        triggerButtonFeedback(mathBtn, translate(locale, 'ai.copied'), translate(locale, 'ai.copy'))
        emit('copied', { type: 'tex', text: tex })
      }
    }
    return
  }

  // 3. 点击公式节点本体复制 LaTeX
  const mathNode = target.closest('.math-node') as HTMLElement | null
  if (mathNode) {
    const tex = mathNode.dataset.tex || ''
    if (tex) {
      event.preventDefault()
      const ok = await copyToClipboard(tex)
      if (ok) {
        mathNode.classList.add('copied')
        const timer = setTimeout(() => {
          mathNode.classList.remove('copied')
          activeTimers.delete(timer)
        }, 600)
        activeTimers.add(timer)
        emit('copied', { type: 'tex', text: tex })
      }
    }
  }
}

onMounted(async () => {
  isMounted.value = true
  const h = await getOrCreateHighlighter()
  if (h) {
    highlighterReady.value = true
  }
})

onUnmounted(() => {
  clearStreamThrottleTimer()
  activeTimers.forEach((timer) => clearTimeout(timer))
  activeTimers.clear()
})
</script>

<template>
  <div
    ref="rootContainerRef"
    class="ai-markdown-content"
    :class="[customClass, { 'is-streaming': isStreaming }]"
    @click="handleContainerClick"
    v-html="renderedHtml"
  />
</template>

<style scoped>
/* ================= 全局容器与排版基准 (随侧边栏无极拉伸动态缩放) ================= */
.ai-markdown-content {
  font-family: var(--lec-font-body);
  font-size: var(--ai-chat-font-size, 14px) !important;
  line-height: var(--ai-chat-line-height, 1.65) !important;
  color: var(--lec-text);
  word-break: break-word;
  transition: font-size 0.28s ease, line-height 0.28s ease;
}

/* 消息正文基础元素 */
.ai-markdown-content :deep(p),
.ai-markdown-content :deep(li),
.ai-markdown-content :deep(blockquote) {
  margin: 0.6em 0;
  font-size: var(--ai-chat-font-size, 14px) !important;
  line-height: var(--ai-chat-line-height, 1.65) !important;
  transition: font-size 0.28s ease, line-height 0.28s ease;
}

.ai-markdown-content :deep(p:first-child) {
  margin-top: 0;
}

.ai-markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

.ai-markdown-content :deep(h1),
.ai-markdown-content :deep(h2),
.ai-markdown-content :deep(h3),
.ai-markdown-content :deep(h4) {
  margin: 1em 0 0.4em;
  font-weight: 600;
  line-height: 1.35;
  color: var(--lec-text);
}

.ai-markdown-content :deep(h1) { font-size: 1.25em; border-bottom: 1px solid var(--lec-border); padding-bottom: 0.3em; }
.ai-markdown-content :deep(h2) { font-size: 1.15em; }
.ai-markdown-content :deep(h3) { font-size: 1.05em; }
.ai-markdown-content :deep(h4) { font-size: 1em; }

.ai-markdown-content :deep(ul),
.ai-markdown-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.3em;
}

.ai-markdown-content :deep(li) {
  margin: 0.25em 0;
}

.ai-markdown-content :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.5em 0.8em;
  border-left: 3px solid var(--lec-accent);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  border-radius: 0 var(--lec-radius-1) var(--lec-radius-1) 0;
}

.ai-markdown-content :deep(hr) {
  margin: 1em 0;
  border: none;
  border-top: 1px solid var(--lec-border);
}

.ai-markdown-content :deep(a) {
  color: var(--lec-accent);
  text-decoration: none;
  font-weight: 500;
}

.ai-markdown-content :deep(a:hover) {
  text-decoration: underline;
}

/* 行内代码 */
.ai-markdown-content :deep(:not(pre) > code) {
  font-family: var(--lec-font-mono);
  font-size: 0.88em;
  padding: 0.15em 0.4em;
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text);
  border: 1px solid var(--lec-border);
}

/* 表格布局 */
.ai-markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 0.9em;
  display: block;
  overflow-x: auto;
}

.ai-markdown-content :deep(th),
.ai-markdown-content :deep(td) {
  border: 1px solid var(--lec-border);
  padding: 6px 10px;
  text-align: left;
}

.ai-markdown-content :deep(th) {
  background: var(--lec-surface);
  font-weight: 600;
}

/* ================= 数学公式渲染样式 ================= */
.ai-markdown-content :deep(.math-node) {
  cursor: copy;
  border-radius: var(--lec-radius-1);
  transition: background-color 0.15s ease;
}

.ai-markdown-content :deep(.math-node:hover) {
  background-color: var(--lec-accent-tint);
}

.ai-markdown-content :deep(.math-node.copied) {
  background-color: var(--lec-accent-tint);
}

/* 行内公式 */
.ai-markdown-content :deep(.math-inline) {
  display: inline-block;
  vertical-align: middle;
  padding: 0 0.15em;
  font-size: var(--lec-math-inline-size, 0.9em);
}

/* 行间公式独立容器 */
.ai-markdown-content :deep(.ai-math-block-container) {
  margin: 0.8em 0;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  overflow: hidden;
}

.ai-markdown-content :deep(.ai-math-toolbar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 8px;
  background: var(--lec-bg);
  border-bottom: 1px solid var(--lec-border);
  font-size: 11px;
}

.ai-markdown-content :deep(.ai-math-tag) {
  font-family: var(--lec-font-mono);
  font-weight: 600;
  color: var(--lec-text-muted);
  letter-spacing: 0.5px;
}

.ai-markdown-content :deep(.ai-math-copy-btn),
.ai-markdown-content :deep(.ai-code-copy-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text-muted);
  font-size: 11px;
  font-family: var(--lec-font-mono);
  cursor: pointer;
  transition: all 0.15s ease;
}

.ai-markdown-content :deep(.ai-math-copy-btn:hover),
.ai-markdown-content :deep(.ai-code-copy-btn:hover) {
  background: var(--lec-surface);
  color: var(--lec-accent);
  border-color: var(--lec-accent);
}

.ai-markdown-content :deep(.ai-math-copy-btn.copied),
.ai-markdown-content :deep(.ai-code-copy-btn.copied) {
  background: var(--lec-accent-tint);
  color: var(--lec-accent);
  border-color: var(--lec-accent);
}

.ai-markdown-content :deep(.btn-icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ai-markdown-content :deep(.math-block) {
  margin: 0;
  padding: 10px 14px;
  overflow-x: auto;
  text-align: center;
}

/* ================= 代码块与 Shiki 高亮 ================= */
.ai-markdown-content :deep(.ai-code-block) {
  margin: 0.8em 0;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  overflow: hidden;
}

.ai-markdown-content :deep(.ai-code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--lec-bg);
  border-bottom: 1px solid var(--lec-border);
}

.ai-markdown-content :deep(.ai-code-lang) {
  font-family: var(--lec-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--lec-text-muted);
}

.ai-markdown-content :deep(.ai-code-body) {
  position: relative;
  overflow-x: auto;
}

.ai-markdown-content :deep(.ai-code-body pre) {
  margin: 0;
  padding: 10px 14px;
  font-family: var(--lec-font-mono);
  font-size: 12.5px;
  line-height: 1.55;
  background-color: transparent !important;
}

/* Shiki 深浅色主题自适应规则 */
.ai-markdown-content :deep(.shiki) {
  background-color: transparent !important;
}

html.dark .ai-markdown-content :deep(.shiki) {
  color: var(--shiki-dark) !important;
}

html.dark .ai-markdown-content :deep(.shiki span) {
  color: var(--shiki-dark) !important;
}

html:not(.dark) .ai-markdown-content :deep(.shiki) {
  color: var(--shiki-light, inherit) !important;
}

html:not(.dark) .ai-markdown-content :deep(.shiki span) {
  color: var(--shiki-light, inherit) !important;
}

/* 未完成流式打字态指示 */
.ai-markdown-content.is-streaming :deep(p:last-child::after) {
  content: '▋';
  display: inline-block;
  margin-left: 2px;
  vertical-align: baseline;
  color: var(--lec-accent);
  animation: pulse-caret 1s infinite;
}

@keyframes pulse-caret {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
