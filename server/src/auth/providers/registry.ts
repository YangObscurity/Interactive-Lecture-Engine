import type { AppConfig } from '../../config/schema.js'
import type { AuthMethodMetadata, AuthMethodProvider } from './types.js'

export class AuthProviderRegistry {
  private readonly providers = new Map<string, AuthMethodProvider>()

  constructor() {
    this.registerDefaults()
  }

  register(provider: AuthMethodProvider): void {
    this.providers.set(provider.id, provider)
  }

  unregister(id: string): boolean {
    return this.providers.delete(id)
  }

  get(id: string): AuthMethodProvider | undefined {
    return this.providers.get(id)
  }

  list(config: AppConfig): AuthMethodMetadata[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: p.isEnabled(config),
      implemented: p.implemented,
      extensible: p.extensible,
      ...(p.endpoints ? { endpoints: p.endpoints } : {}),
    }))
  }

  private registerDefaults(): void {
    // 1. Password provider
    this.register({
      id: 'password',
      name: 'Password',
      description: '本地账号密码认证（基于 scrypt 密码哈希）',
      implemented: true,
      extensible: false,
      endpoints: {
        login: '/api/auth/login',
        bootstrap: '/api/auth/bootstrap',
      },
      isEnabled(config: AppConfig): boolean {
        return (
          (config.authAdapter === 'local' || config.authAdapter === 'hybrid') &&
          config.authMethodsEnabled
            .split(',')
            .map((s) => s.trim())
            .includes('password')
        )
      },
    })

    // 2. Passkey / WebAuthn provider
    this.register({
      id: 'passkey',
      name: 'Passkey / WebAuthn',
      description: '生物识别与通行密钥认证（FIDO2 / WebAuthn，支持 ES256 / RS256）',
      implemented: true,
      extensible: false,
      endpoints: {
        registerStart: '/api/auth/methods/passkey/register/start',
        registerFinish: '/api/auth/methods/passkey/register/finish',
        loginStart: '/api/auth/methods/passkey/login/start',
        loginFinish: '/api/auth/methods/passkey/login/finish',
      },
      isEnabled(config: AppConfig): boolean {
        return (
          (config.authAdapter === 'local' || config.authAdapter === 'hybrid') &&
          config.authMethodsEnabled
            .split(',')
            .map((s) => s.trim())
            .includes('passkey')
        )
      },
    })

    // 3. Gateway provider
    this.register({
      id: 'gateway',
      name: 'Gateway Header',
      description: '前置反向代理网关身份透传（Authelia / Authentik / OAuth2-Proxy）',
      implemented: true,
      extensible: false,
      isEnabled(config: AppConfig): boolean {
        return (
          (config.authAdapter === 'trusted-header' || config.authAdapter === 'hybrid') &&
          config.authMethodsEnabled
            .split(',')
            .map((s) => s.trim())
            .includes('gateway')
        )
      },
    })

    // 4. Extensible slot: OIDC
    this.register({
      id: 'oidc',
      name: 'OpenID Connect / OAuth2',
      description: '企业级单点登录扩展插槽（Keycloak, Google, GitHub, Okta 等）',
      implemented: false,
      extensible: true,
      isEnabled(): boolean {
        return false
      },
    })

    // 5. Extensible slot: TOTP
    this.register({
      id: 'totp',
      name: 'TOTP 2FA Authenticator',
      description: '基于时间的一次性密码双因子验证插槽（RFC 6238）',
      implemented: false,
      extensible: true,
      isEnabled(): boolean {
        return false
      },
    })
  }
}

export const defaultAuthRegistry = new AuthProviderRegistry()
