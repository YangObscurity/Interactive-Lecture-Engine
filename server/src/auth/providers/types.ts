import type { AppConfig } from '../../config/schema.js'

export interface AuthMethodMetadata {
  id: string
  name: string
  description: string
  enabled: boolean
  implemented: boolean
  extensible: boolean
  endpoints?: Record<string, string>
}

export interface AuthMethodProvider {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly implemented: boolean
  readonly extensible: boolean
  readonly endpoints?: Record<string, string>
  isEnabled(config: AppConfig): boolean
}
