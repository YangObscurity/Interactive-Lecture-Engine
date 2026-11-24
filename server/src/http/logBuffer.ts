import { randomUUID } from 'node:crypto'

export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  category: 'http' | 'auth' | 'admin' | 'error'
  message: string
  details?: Record<string, unknown>
}

export class LogBuffer {
  private readonly capacity: number
  private readonly buffer: LogEntry[] = []

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  add(entry: Omit<LogEntry, 'id' | 'timestamp'>): LogEntry {
    const sanitizedDetails = entry.details ? this.sanitize(entry.details) : undefined
    const item: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level: entry.level,
      category: entry.category,
      message: this.sanitizeString(entry.message),
      ...(sanitizedDetails ? { details: sanitizedDetails } : {}),
    }

    if (this.buffer.length >= this.capacity) {
      this.buffer.shift()
    }
    this.buffer.push(item)
    return item
  }

  getEntries(options?: { limit?: number; level?: string; category?: string }): LogEntry[] {
    let items = [...this.buffer]
    if (options?.level && options.level !== 'all') {
      items = items.filter((i) => i.level === options.level)
    }
    if (options?.category && options.category !== 'all') {
      items = items.filter((i) => i.category === options.category)
    }
    const limit = options?.limit ?? 50
    return items.slice(-limit).reverse()
  }

  private sanitizeString(str: string): string {
    return str
      .replace(/(postgres(?:ql)?:\/\/)([^:\s/]+):([^@\s/]+)@/gi, '$1***:***@')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(
        /("(?:password|password_hash|token_hash|token|secret|apiKey|api_key|authorization|cookie)"\s*:\s*")[^"]*"/gi,
        '$1[REDACTED]"',
      )
      .replace(
        /\b(password_hash|token_hash|password|secret|api_key|apikey)\s*[:=]\s*\S+/gi,
        '$1=[REDACTED]',
      )
  }

  private sanitizeValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.sanitizeString(value)
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item))
    }
    if (typeof value === 'object' && value !== null) {
      return this.sanitize(value as Record<string, unknown>)
    }
    return value
  }

  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase()
      if (
        lower.includes('password') ||
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('hash') ||
        lower.includes('authorization') ||
        lower.includes('cookie') ||
        lower.includes('apikey') ||
        lower.includes('api_key') ||
        lower.includes('credential')
      ) {
        out[k] = '[REDACTED]'
      } else {
        out[k] = this.sanitizeValue(v)
      }
    }
    return out
  }
}

export const serverLogBuffer = new LogBuffer(1000)
