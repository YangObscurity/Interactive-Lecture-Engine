/**
 * pptxUploader.ts — 课件导学与考点映射上传处理器
 *
 * 职责：
 *   1. 校验 .pptx (及 .pdf) 课件文档合法性（<= 50MB 尺寸限制与 MIME/扩展名校验）；
 *   2. 处理向 /api/ai/upload 发起的多部件文件上传，对接 Dify Agent 课件分析沙箱；
 *   3. 解析 AI 返回的课件考点分析文本，结构化提取幻灯片至讲义小节的映射条目 (Slide-to-Lecture Mappings)；
 *   4. 提供复习考点清单格式化工具，对接 Neon PostgreSQL 存储。
 *
 * 规范：严格 TypeScript 类型，无 any，SSR 安全，无 Emoji。
 */

import { API_ENDPOINTS } from '../../../site.config'

/** 允许上传的最大文件尺寸：50MB */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

/** 支持的文件扩展名列表 */
export const SUPPORTED_EXTENSIONS = ['.pptx', '.pdf', '.ppt'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

/** 支持的 MIME 类型列表 */
export const SUPPORTED_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/pdf'
] as const

/** 文件校验结果接口 */
export interface FileValidationResult {
  valid: boolean
  error?: string
  extension?: SupportedExtension
  fileSizeFormatted?: string
}

/** Dify 文件上传响应标准结构 */
export interface DifyUploadedFile {
  id: string
  name: string
  size: number
  extension: string
  mimeType: string
  createdAt?: number
}

/** 文件上传请求配置选项 */
export interface UploadOptions {
  endpoint?: string
  user?: string
  signal?: AbortSignal
  onProgress?: (progressPercent: number) => void
}

/** 上传执行结果结构 */
export interface UploadResult {
  success: boolean
  file?: DifyUploadedFile
  analysisText?: string
  error?: string
}

/** 课件幻灯片与讲义小节精准映射实体 */
export interface SlideLectureMapping {
  slideNumber: number
  slideTitle: string
  matchedLectureId: string
  matchedLectureTitle: string
  matchedSection: string
  lecturePath: string
  keyTakeaway: string
  isCompleted: boolean
}

/** 云端数据库复习考点清单入库载荷 */
export interface ChecklistPayload {
  slidePage: number
  lectureId: string
  sectionAnchor: string
  keyTakeaway: string
  isCompleted: boolean
}

/**
 * 格式化文件字节数为易读字符串 (KB / MB)
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`
  }
  const mb = kb / 1024
  return `${mb.toFixed(2)} MB`
}

/**
 * 校验课件文件合法性
 * - 尺寸检查：必须大于 0 且不超过 50MB
 * - 扩展名检查：支持 .pptx, .ppt, .pdf
 * - MIME 检查：在浏览器提供非空 MIME 时核对白名单
 */
export function validateLectureFile(file: File): FileValidationResult {
  if (!file) {
    return { valid: false, error: '未选择任何文件' }
  }

  // 1. 文件大小检查
  if (file.size === 0) {
    return { valid: false, error: '文件大小为 0 字节，无法上传空文件' }
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `文件大小超过 50MB 限制 (当前大小: ${formatFileSize(file.size)})`,
      fileSizeFormatted: formatFileSize(file.size)
    }
  }

  // 2. 扩展名提取与检查
  const fileName = file.name || ''
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex === -1) {
    return {
      valid: false,
      error: '文件缺少扩展名，仅支持 .pptx 或 .pdf 课件文档'
    }
  }

  const rawExt = fileName.slice(dotIndex).toLowerCase()
  const matchedExt = SUPPORTED_EXTENSIONS.find((ext) => ext === rawExt)
  if (!matchedExt) {
    return {
      valid: false,
      error: `不支持的文件格式 [${rawExt}]，仅支持 .pptx 或 .pdf 课件文档`
    }
  }

  // 3. MIME 类型检查（部分系统环境下 file.type 可能为空或 application/octet-stream，放行并依赖扩展名）
  if (file.type && file.type !== 'application/octet-stream') {
    const isMimeSupported = SUPPORTED_MIME_TYPES.some((m) => m === file.type)
    if (!isMimeSupported) {
      return {
        valid: false,
        error: `文件 MIME 类型不匹配 [${file.type}]，请上传标准的 PPTX 或 PDF 课件文档`
      }
    }
  }

  return {
    valid: true,
    extension: matchedExt,
    fileSizeFormatted: formatFileSize(file.size)
  }
}

/**
 * 类型守卫：安全校验并解析 Dify 上传接口返回的未知数据
 */
function parseDifyFileResponse(data: unknown): DifyUploadedFile | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const record = data as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof record.name === 'string' ? record.name : ''
  const size = typeof record.size === 'number' ? record.size : 0
  const extension = typeof record.extension === 'string' ? record.extension : ''
  const mimeType = typeof record.mime_type === 'string' ? record.mime_type : ''
  const createdAt = typeof record.created_at === 'number' ? record.created_at : undefined

  if (!id) {
    return null
  }

  return {
    id,
    name,
    size,
    extension,
    mimeType,
    createdAt
  }
}

/**
 * 上传课件文件至后端中转代理接口 (/api/ai/upload)
 * 具备进度监听、取消请求控制与 SSR 安全守卫。
 */
export function uploadLectureFile(
  file: File,
  options: UploadOptions = {}
): Promise<UploadResult> {
  // SSR 安全保护
  if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') {
    return Promise.resolve({
      success: false,
      error: '当前环境不支持浏览器文件上传 API (SSR 保护)'
    })
  }

  const validation = validateLectureFile(file)
  if (!validation.valid) {
    return Promise.resolve({
      success: false,
      error: validation.error || '文件校验未通过'
    })
  }

  return new Promise<UploadResult>((resolve) => {
    const xhr = new XMLHttpRequest()
    const endpoint = options.endpoint || API_ENDPOINTS.aiUpload
    const formData = new FormData()

    formData.append('file', file)
    formData.append('user', options.user || 'lecture-learner')

    // 监听函数引用以供事后解绑，杜绝内存泄漏
    let onSignalAbort: (() => void) | null = null
    let onProgress: ((e: ProgressEvent) => void) | null = null
    let onLoad: (() => void) | null = null
    let onError: (() => void) | null = null
    let onAbort: (() => void) | null = null

    const cleanupListeners = () => {
      if (options.signal && onSignalAbort) {
        options.signal.removeEventListener('abort', onSignalAbort)
      }
      if (xhr.upload && onProgress) {
        xhr.upload.removeEventListener('progress', onProgress)
      }
      if (onLoad) xhr.removeEventListener('load', onLoad)
      if (onError) xhr.removeEventListener('error', onError)
      if (onAbort) xhr.removeEventListener('abort', onAbort)
    }

    // 监听外部取消信号
    if (options.signal) {
      if (options.signal.aborted) {
        resolve({ success: false, error: '上传已被用户主动取消' })
        return
      }
      onSignalAbort = () => {
        cleanupListeners()
        xhr.abort()
        resolve({ success: false, error: '上传已被用户主动取消' })
      }
      options.signal.addEventListener('abort', onSignalAbort)
    }

    // 上传进度监听
    if (options.onProgress && xhr.upload) {
      onProgress = (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) {
          const percent = Math.round((e.loaded / e.total) * 100)
          options.onProgress!(Math.min(100, Math.max(0, percent)))
        }
      }
      xhr.upload.addEventListener('progress', onProgress)
    }

    // 请求完成监听
    onLoad = () => {
      cleanupListeners()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const rawData: unknown = JSON.parse(xhr.responseText)
          const parsed = parseDifyFileResponse(rawData)
          if (parsed) {
            resolve({ success: true, file: parsed })
          } else {
            resolve({
              success: false,
              error: '上传响应缺少核心文件标识'
            })
          }
        } catch {
          resolve({
            success: false,
            error: '接口返回数据非合规 JSON 结构'
          })
        }
      } else {
        let errorMsg = `上传失败 (HTTP ${xhr.status})`
        try {
          const errData: unknown = JSON.parse(xhr.responseText)
          if (typeof errData === 'object' && errData !== null) {
            const errRecord = errData as Record<string, unknown>
            if (typeof errRecord.message === 'string') {
              errorMsg = errRecord.message
            } else if (typeof errRecord.error === 'string') {
              errorMsg = errRecord.error
            }
          }
        } catch {
          // 保持默认状态码提示
        }
        resolve({ success: false, error: errorMsg })
      }
    }
    xhr.addEventListener('load', onLoad)

    // 网络异常监听
    onError = () => {
      cleanupListeners()
      resolve({ success: false, error: '网络通信中断，文件上传失败' })
    }
    xhr.addEventListener('error', onError)

    // 超时或中断监听
    onAbort = () => {
      cleanupListeners()
      resolve({ success: false, error: '文件上传已终止' })
    }
    xhr.addEventListener('abort', onAbort)

    xhr.open('POST', endpoint, true)
    xhr.send(formData)
  })
}

/**
 * 辅助函数：根据小节标题生成 VitePress 规范锚点
 */
export function generateSectionAnchor(sectionText: string): string {
  if (!sectionText) return ''
  const cleaned = sectionText.trim().replace(/^#+\s*/, '')
  const slug = cleaned
    .toLowerCase()
    .replace(/[\s\t\n]+/g, '-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, '')
  if (/^[0-9]/.test(slug)) {
    return `_${slug}`
  }
  return slug
}

/**
 * 解析未知项为单条 SlideLectureMapping
 */
function normalizeMappingItem(raw: Record<string, unknown>): SlideLectureMapping | null {
  // 解析页码
  let slideNumber = 0
  if (typeof raw.slideNumber === 'number') {
    slideNumber = raw.slideNumber
  } else if (typeof raw.slide === 'number') {
    slideNumber = raw.slide
  } else if (typeof raw.page === 'number') {
    slideNumber = raw.page
  } else if (typeof raw.slide_number === 'number') {
    slideNumber = raw.slide_number
  } else {
    const pageStr = String(raw.slideNumber || raw.slide || raw.page || raw.slide_number || '')
    const matched = pageStr.match(/\d+/)
    if (matched) {
      slideNumber = parseInt(matched[0], 10)
    }
  }

  if (slideNumber <= 0) return null

  // 解析讲义编号
  const idCandidates = [raw.matchedLectureId, raw.lectureId, raw.lecture_id, raw.id]
  let matchedLectureId = ''
  for (const c of idCandidates) {
    if (typeof c === 'string') {
      const m = c.match(/[A-Za-z0-9]+-L\d{2}/i)
      if (m) {
        matchedLectureId = m[0].toUpperCase()
        break
      }
    }
  }

  const slideTitle = typeof raw.slideTitle === 'string'
    ? raw.slideTitle
    : typeof raw.title === 'string'
    ? raw.title
    : typeof raw.topic === 'string'
    ? raw.topic
    : `幻灯片第 ${slideNumber} 页考点`

  const matchedLectureTitle = typeof raw.matchedLectureTitle === 'string'
    ? raw.matchedLectureTitle
    : typeof raw.lectureTitle === 'string'
    ? raw.lectureTitle
    : matchedLectureId ? `讲义 ${matchedLectureId}` : '待定讲次'

  const matchedSection = typeof raw.matchedSection === 'string'
    ? raw.matchedSection
    : typeof raw.section === 'string'
    ? raw.section
    : typeof raw.chapter === 'string'
    ? raw.chapter
    : ''

  let lecturePath = typeof raw.lecturePath === 'string'
    ? raw.lecturePath
    : typeof raw.path === 'string'
    ? raw.path
    : typeof raw.url === 'string'
    ? raw.url
    : ''

  if (!lecturePath && matchedLectureId) {
    const parts = matchedLectureId.split('-')
    if (parts.length === 2) {
      lecturePath = `/${parts[0].toLowerCase()}/${parts[1].toUpperCase()}`
    }
  }

  if (lecturePath && matchedSection && !lecturePath.includes('#')) {
    const anchor = generateSectionAnchor(matchedSection)
    if (anchor) {
      lecturePath = `${lecturePath}#${anchor}`
    }
  }

  const keyTakeaway = typeof raw.keyTakeaway === 'string'
    ? raw.keyTakeaway
    : typeof raw.takeaway === 'string'
    ? raw.takeaway
    : typeof raw.notes === 'string'
    ? raw.notes
    : typeof raw.summary === 'string'
    ? raw.summary
    : '课件重点内容推导'

  const isCompleted = typeof raw.isCompleted === 'boolean'
    ? raw.isCompleted
    : typeof raw.completed === 'boolean'
    ? raw.completed
    : false

  return {
    slideNumber,
    slideTitle: slideTitle.trim(),
    matchedLectureId,
    matchedLectureTitle: matchedLectureTitle.trim(),
    matchedSection: matchedSection.trim(),
    lecturePath: lecturePath.trim(),
    keyTakeaway: keyTakeaway.trim(),
    isCompleted
  }
}

/**
 * 从 JSON 文本块中解析映射列表
 */
function tryParseJsonBlock(content: string): SlideLectureMapping[] {
  const jsonBlockRegex = /```(?:json)?\s*(\[\s*\{[\s\S]*?\}\s*\])\s*```/i
  const match = content.match(jsonBlockRegex)
  const jsonStr = match ? match[1] : null

  if (!jsonStr) {
    // 尝试寻找直接以 [ 开头并以 ] 结尾的 JSON 数组
    const bareArrayMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/)
    if (!bareArrayMatch) return []
    try {
      const parsed: unknown = JSON.parse(bareArrayMatch[0])
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map(normalizeMappingItem)
          .filter((item): item is SlideLectureMapping => item !== null)
      }
    } catch {
      return []
    }
    return []
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr)
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map(normalizeMappingItem)
        .filter((item): item is SlideLectureMapping => item !== null)
    }
  } catch {
    return []
  }

  return []
}

/**
 * 从 Markdown 表格中解析映射列表
 */
function tryParseMarkdownTable(content: string): SlideLectureMapping[] {
  const lines = content.split('\n')
  const tableRows: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableRows.push(trimmed)
    }
  }

  if (tableRows.length < 3) return []

  const headerCells = tableRows[0]
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim().toLowerCase())

  // 定位各列索引
  const slideIdx = headerCells.findIndex((c) => /页码|幻灯片|slide|page/.test(c))
  const titleIdx = headerCells.findIndex((c) => /考点|主题|知识点|title|topic/.test(c))
  const lectureIdx = headerCells.findIndex((c) => /讲次|讲号|匹配|lecture/.test(c))
  const sectionIdx = headerCells.findIndex((c) => /小节|章节|section/.test(c))
  const pathIdx = headerCells.findIndex((c) => /链接|路径|直达|path|url/.test(c))
  const takeawayIdx = headerCells.findIndex((c) => /重点|建议|备考|解析|takeaway|note/.test(c))

  if (slideIdx === -1 && lectureIdx === -1) return []

  const results: SlideLectureMapping[] = []

  // 跳过表头和分隔线（第二行）
  for (let i = 2; i < tableRows.length; i++) {
    const row = tableRows[i]
    if (/^\|\s*[-:]+\s*\|/.test(row)) continue

    const cells = row.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue

    const slideText = slideIdx !== -1 ? cells[slideIdx] : cells[0]
    const slideMatch = slideText.match(/\d+/)
    const slideNumber = slideMatch ? parseInt(slideMatch[0], 10) : i - 1

    const rawLectureText = lectureIdx !== -1 ? cells[lectureIdx] : ''
    const lectureIdMatch = rawLectureText.match(/[A-Za-z0-9]+-L\d{2}/i)
    const matchedLectureId = lectureIdMatch ? lectureIdMatch[0].toUpperCase() : ''

    const slideTitle = titleIdx !== -1 ? cells[titleIdx] : `幻灯片第 ${slideNumber} 页`
    const matchedSection = sectionIdx !== -1 ? cells[sectionIdx] : ''
    let lecturePath = pathIdx !== -1 ? cells[pathIdx] : ''
    const keyTakeaway = takeawayIdx !== -1 ? cells[takeawayIdx] : '考点精读对照'

    if (!lecturePath && matchedLectureId) {
      const parts = matchedLectureId.split('-')
      if (parts.length === 2) {
        lecturePath = `/${parts[0].toLowerCase()}/${parts[1].toUpperCase()}`
      }
    }

    if (lecturePath && matchedSection && !lecturePath.includes('#')) {
      const anchor = generateSectionAnchor(matchedSection)
      if (anchor) lecturePath = `${lecturePath}#${anchor}`
    }

    results.push({
      slideNumber,
      slideTitle,
      matchedLectureId,
      matchedLectureTitle: rawLectureText || (matchedLectureId ? `讲义 ${matchedLectureId}` : ''),
      matchedSection,
      lecturePath,
      keyTakeaway,
      isCompleted: false
    })
  }

  return results
}

/**
 * 解析 Dify Agent 针对课件输出的分析文本，提取出结构化映射清单
 * 支持多种输出格式：JSON 结构块、Markdown 表格、或结构化清单。
 */
export function parseSlideMappings(aiResponseText: string): SlideLectureMapping[] {
  if (!aiResponseText || typeof aiResponseText !== 'string') {
    return []
  }

  // 1. 优先尝试提取 JSON 块
  const jsonResults = tryParseJsonBlock(aiResponseText)
  if (jsonResults.length > 0) {
    return jsonResults.sort((a, b) => a.slideNumber - b.slideNumber)
  }

  // 2. 降级尝试提取 Markdown 表格
  const tableResults = tryParseMarkdownTable(aiResponseText)
  if (tableResults.length > 0) {
    return tableResults.sort((a, b) => a.slideNumber - b.slideNumber)
  }

  // 3. 兜底逐行正则匹配
  const fallbackResults: SlideLectureMapping[] = []
  const lines = aiResponseText.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    const pageMatch = trimmed.match(/(?:第\s*(\d+)\s*页|[Pp](?:age)?\.?\s*(\d+))/i)
    const idMatch = trimmed.match(/([A-Za-z0-9]+-L\d{2})/i)

    if (pageMatch && idMatch) {
      const numStr = pageMatch[1] || pageMatch[2]
      const slideNumber = parseInt(numStr, 10)
      const matchedLectureId = idMatch[1].toUpperCase()
      const parts = matchedLectureId.split('-')
      const lecturePath = `/${parts[0].toLowerCase()}/${parts[1].toUpperCase()}`

      fallbackResults.push({
        slideNumber,
        slideTitle: `幻灯片第 ${slideNumber} 页考点`,
        matchedLectureId,
        matchedLectureTitle: `讲义 ${matchedLectureId}`,
        matchedSection: '',
        lecturePath,
        keyTakeaway: trimmed.replace(/^[*-]\s*/, ''),
        isCompleted: false
      })
    }
  }

  return fallbackResults.sort((a, b) => a.slideNumber - b.slideNumber)
}

/**
 * 将映射条目序列化为标准 Markdown 表格
 */
export function formatMappingsToMarkdown(mappings: SlideLectureMapping[]): string {
  if (!mappings.length) return ''

  const rows = [
    '| 课件页码 | 核心考点 | 对应讲次 | 推荐小节 | 站内直达 | 备考重点与建议 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |'
  ]

  for (const m of mappings) {
    const link = m.lecturePath ? `[直达讲义](${m.lecturePath})` : '-'
    rows.push(
      `| 第 ${m.slideNumber} 页 | ${m.slideTitle || '-'} | ${m.matchedLectureId || '-'} | ${m.matchedSection || '-'} | ${link} | ${m.keyTakeaway || '-'} |`
    )
  }

  return rows.join('\n')
}

/**
 * 转换映射条目为 Neon PostgreSQL ai_review_checklists 入库格式
 */
export function formatMappingsForChecklist(
  mappings: SlideLectureMapping[],
  fallbackLectureId = ''
): ChecklistPayload[] {
  return mappings.map((m) => {
    const lectureId = m.matchedLectureId || fallbackLectureId
    const sectionAnchor = m.matchedSection ? generateSectionAnchor(m.matchedSection) : ''

    return {
      slidePage: m.slideNumber,
      lectureId,
      sectionAnchor,
      keyTakeaway: m.keyTakeaway || m.slideTitle || '核心考点',
      isCompleted: m.isCompleted
    }
  })
}

/**
 * 课件上传与考点映射一体化高级函数
 */
export async function uploadAndMapPptx(file: File): Promise<{
  mappings: SlideLectureMapping[]
  formattedMarkdown: string
}> {
  const uploadRes = await uploadLectureFile(file)
  if (!uploadRes.success || !uploadRes.file) {
    throw new Error(uploadRes.error || '课件上传失败')
  }

  const text = uploadRes.analysisText || `已成功解析课件文件: ${file.name} (大小: ${formatFileSize(file.size)})。正在对齐全站讲义考点...`
  const mappings = parseSlideMappings(text)
  const formattedMarkdown = formatMappingsToMarkdown(mappings) || text

  return {
    mappings,
    formattedMarkdown
  }
}
