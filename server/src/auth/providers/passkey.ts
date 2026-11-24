import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import type { AppConfig, Role } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { cborDecode } from './cbor.js'

export interface RequestContext {
  host?: string
  url: string
  headers?: (name: string) => string | undefined
}

export interface WebAuthnUser {
  id: string
  username: string
  displayName?: string
  roles?: Role[]
}

export { isOriginAllowed } from '../origin.js'
import { isOriginAllowed } from '../origin.js'

export function resolveRpId(cfg: AppConfig, host?: string): string {
  if (cfg.webauthnRpId && cfg.webauthnRpId.trim() !== '') {
    return cfg.webauthnRpId.trim()
  }
  if (!host) return 'localhost'
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end !== -1) {
      return h.slice(1, end)
    }
  }
  const colonIdx = h.indexOf(':')
  if (colonIdx !== -1) {
    h = h.slice(0, colonIdx)
  }
  return h || 'localhost'
}

export async function createRegistrationOptions(
  db: Db,
  cfg: AppConfig,
  reqCtx: RequestContext,
  user: WebAuthnUser,
): Promise<{
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>
  timeout: number
  attestation: 'none'
  excludeCredentials: Array<{ id: string; type: 'public-key'; transports?: string[] }>
  authenticatorSelection: {
    residentKey: 'preferred'
    userVerification: 'preferred'
  }
}> {
  const challenge = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
  const rpId = resolveRpId(cfg, reqCtx.host)

  await db.query(
    `INSERT INTO auth_challenges (challenge, kind, method, user_id, expires_at)
     VALUES ($1, 'register', 'passkey', $2, $3)`,
    [challenge, user.id, expiresAt.toISOString()],
  )

  const existingCreds = await db.query<{
    credential_id: string
    transports: string[] | string
  }>(
    `SELECT credential_id, transports FROM auth_credentials WHERE user_id = $1 AND method = 'passkey'`,
    [user.id],
  )

  const excludeCredentials = existingCreds.rows.map((row) => {
    let transports: string[] = []
    if (Array.isArray(row.transports)) {
      transports = row.transports
    } else if (typeof row.transports === 'string') {
      try {
        transports = JSON.parse(row.transports) as string[]
      } catch {
        transports = []
      }
    }
    return {
      id: row.credential_id,
      type: 'public-key' as const,
      ...(transports.length > 0 ? { transports } : {}),
    }
  })

  return {
    challenge,
    rp: {
      id: rpId,
      name: cfg.webauthnRpName || 'Interactive Lecture Engine',
    },
    user: {
      id: Buffer.from(user.id, 'utf8').toString('base64url'),
      name: user.username,
      displayName: user.displayName || user.username,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    timeout: 60000,
    attestation: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  }
}

export interface RegistrationResponseBody {
  id: string
  rawId?: string
  response: {
    clientDataJSON: string
    attestationObject: string
    transports?: string[]
  }
  label?: string
}

export async function verifyRegistrationResponse(
  db: Db,
  cfg: AppConfig,
  reqCtx: RequestContext,
  user: WebAuthnUser,
  body: RegistrationResponseBody,
): Promise<{ ok: true; credentialId: string; label: string }> {
  if (!body?.response?.clientDataJSON || !body?.response?.attestationObject) {
    throw new Error('invalid_registration_payload')
  }

  const clientDataBuf = Buffer.from(body.response.clientDataJSON, 'base64url')
  let clientData: { type?: string; challenge?: string; origin?: string }
  try {
    clientData = JSON.parse(clientDataBuf.toString('utf8')) as typeof clientData
  } catch {
    throw new Error('invalid_client_data_json')
  }

  if (clientData.type !== 'webauthn.create') {
    throw new Error('invalid_client_data_type')
  }

  if (!isOriginAllowed(clientData.origin ?? '', cfg, reqCtx.url, reqCtx.host, reqCtx.headers)) {
    throw new Error('invalid_origin')
  }

  const challengeStr = clientData.challenge
  if (!challengeStr) {
    throw new Error('missing_challenge')
  }

  const rpId = resolveRpId(cfg, reqCtx.host)
  const expectedRpIdHash = createHash('sha256').update(rpId).digest()

  const attestationBuf = Buffer.from(body.response.attestationObject, 'base64url')
  const { value: attObj } = cborDecode(attestationBuf)
  if (!(attObj instanceof Map)) {
    throw new Error('invalid_attestation_object')
  }

  const authData = attObj.get('authData')
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    throw new Error('invalid_auth_data')
  }

  const actualRpIdHash = authData.subarray(0, 32)
  if (!actualRpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rp_id_hash_mismatch')
  }

  const flags = authData[32]!
  const userPresent = (flags & 0x01) !== 0
  if (!userPresent) {
    throw new Error('user_not_present')
  }

  const attestedDataPresent = (flags & 0x40) !== 0
  if (!attestedDataPresent) {
    throw new Error('missing_attested_credential_data')
  }

  if (authData.length < 55) {
    throw new Error('invalid_attested_auth_data')
  }

  const signCount = authData.readUInt32BE(33)

  const aaguid = authData.subarray(37, 53).toString('hex')
  const credIdLen = authData.readUInt16BE(53)
  if (credIdLen === 0 || 55 + credIdLen >= authData.length) {
    throw new Error('invalid_credential_id_length')
  }
  const credentialIdBuf = authData.subarray(55, 55 + credIdLen)
  const credentialId = credentialIdBuf.toString('base64url')
  if (body.id && body.id !== credentialId) {
    throw new Error('credential_id_mismatch')
  }

  const coseKeyBuf = authData.subarray(55 + credIdLen)
  const { value: coseKeyMap } = cborDecode(coseKeyBuf)
  if (!(coseKeyMap instanceof Map)) {
    throw new Error('invalid_cose_key')
  }

  const kty = coseKeyMap.get(1) as number
  const alg = coseKeyMap.get(3) as number

  let publicKeyPem: string
  if (kty === 2 && alg === -7) {
    const crv = coseKeyMap.get(-1)
    if (crv !== 1) {
      throw new Error('unsupported_ec_curve')
    }
    const x = coseKeyMap.get(-2) as Buffer
    const y = coseKeyMap.get(-3) as Buffer
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error('invalid_ec_coordinates')
    }
    const keyObj = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: x.toString('base64url'),
        y: y.toString('base64url'),
      },
      format: 'jwk',
    })
    publicKeyPem = keyObj.export({ type: 'spki', format: 'pem' }).toString()
  } else if (kty === 3 && alg === -257) {
    const n = coseKeyMap.get(-1) as Buffer
    const e = coseKeyMap.get(-2) as Buffer
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length === 0 || e.length === 0) {
      throw new Error('invalid_rsa_parameters')
    }
    const keyObj = createPublicKey({
      key: {
        kty: 'RSA',
        n: n.toString('base64url'),
        e: e.toString('base64url'),
      },
      format: 'jwk',
    })
    publicKeyPem = keyObj.export({ type: 'spki', format: 'pem' }).toString()
  } else {
    throw new Error(`unsupported_algorithm_${String(alg)}`)
  }

  const label =
    body.label && typeof body.label === 'string'
      ? body.label.slice(0, 100)
      : 'Passkey'

  const transports = Array.isArray(body.response.transports) ? body.response.transports : []

  // Consume single-use challenge atomically BEFORE transaction so failed verification never restores it
  const consumed = await db.query<{
    challenge: string
    expires_at: string
    user_id: string | null
  }>(
    `DELETE FROM auth_challenges
     WHERE challenge = $1 AND kind = 'register' AND method = 'passkey'
     RETURNING challenge, expires_at, user_id`,
    [challengeStr],
  )
  if (consumed.rowCount === 0 || !consumed.rows[0]) {
    throw new Error('invalid_or_expired_challenge')
  }
  const chRow = consumed.rows[0]
  if (new Date(chRow.expires_at).getTime() < Date.now()) {
    throw new Error('challenge_expired')
  }
  if (chRow.user_id && chRow.user_id !== user.id) {
    throw new Error('challenge_user_mismatch')
  }

  const credId = randomUUID()
  await db.query(
    `INSERT INTO auth_credentials (id, user_id, method, credential_id, public_key, algorithm, sign_count, transports, label, aaguid)
     VALUES ($1, $2, 'passkey', $3, $4, $5, $6, $7, $8, $9)`,
    [
      credId,
      user.id,
      credentialId,
      publicKeyPem,
      alg,
      signCount,
      JSON.stringify(transports),
      label,
      aaguid,
    ],
  )

  return { ok: true, credentialId, label }
}

export async function createAuthenticationOptions(
  db: Db,
  cfg: AppConfig,
  reqCtx: RequestContext,
  usernameOrId?: string,
): Promise<{
  challenge: string
  rpId: string
  timeout: number
  userVerification: 'preferred'
  allowCredentials: Array<{ id: string; type: 'public-key'; transports?: string[] }>
}> {
  const challenge = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
  const rpId = resolveRpId(cfg, reqCtx.host)

  let boundUserId: string | null = null
  let allowCredentials: Array<{ id: string; type: 'public-key'; transports?: string[] }> = []

  if (usernameOrId && usernameOrId.trim() !== '') {
    const query = usernameOrId.trim()
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM auth_users WHERE (username = $1 OR id = $1) AND disabled = FALSE`,
      [query],
    )
    if (userRes.rowCount > 0 && userRes.rows[0]) {
      boundUserId = userRes.rows[0].id
      const creds = await db.query<{
        credential_id: string
        transports: string[] | string
      }>(
        `SELECT credential_id, transports FROM auth_credentials WHERE user_id = $1 AND method = 'passkey'`,
        [boundUserId],
      )
      allowCredentials = creds.rows.map((row) => {
        let transports: string[] = []
        if (Array.isArray(row.transports)) {
          transports = row.transports
        } else if (typeof row.transports === 'string') {
          try {
            transports = JSON.parse(row.transports) as string[]
          } catch {
            transports = []
          }
        }
        return {
          id: row.credential_id,
          type: 'public-key' as const,
          ...(transports.length > 0 ? { transports } : {}),
        }
      })
    }
  }

  await db.query(
    `INSERT INTO auth_challenges (challenge, kind, method, user_id, expires_at)
     VALUES ($1, 'login', 'passkey', $2, $3)`,
    [challenge, boundUserId, expiresAt.toISOString()],
  )

  return {
    challenge,
    rpId,
    timeout: 60000,
    userVerification: 'preferred',
    allowCredentials,
  }
}

export interface AuthenticationResponseBody {
  id: string
  rawId?: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string
  }
}

export interface AuthenticatedPasskeyUser {
  id: string
  username: string
  email: string | null
  displayName: string
  roles: Role[]
}

export async function verifyAuthenticationResponse(
  db: Db,
  cfg: AppConfig,
  reqCtx: RequestContext,
  body: AuthenticationResponseBody,
): Promise<{ ok: true; user: AuthenticatedPasskeyUser }> {
  if (
    !body?.response?.clientDataJSON ||
    !body?.response?.authenticatorData ||
    !body?.response?.signature
  ) {
    throw new Error('invalid_authentication_payload')
  }

  const clientDataBuf = Buffer.from(body.response.clientDataJSON, 'base64url')
  let clientData: { type?: string; challenge?: string; origin?: string }
  try {
    clientData = JSON.parse(clientDataBuf.toString('utf8')) as typeof clientData
  } catch {
    throw new Error('invalid_client_data_json')
  }

  if (clientData.type !== 'webauthn.get') {
    throw new Error('invalid_client_data_type')
  }

  if (!isOriginAllowed(clientData.origin ?? '', cfg, reqCtx.url, reqCtx.host, reqCtx.headers)) {
    throw new Error('invalid_origin')
  }

  const challengeStr = clientData.challenge
  if (!challengeStr) {
    throw new Error('missing_challenge')
  }

  const rpId = resolveRpId(cfg, reqCtx.host)
  const expectedRpIdHash = createHash('sha256').update(rpId).digest()

  const authDataBuf = Buffer.from(body.response.authenticatorData, 'base64url')
  if (authDataBuf.length < 37) {
    throw new Error('invalid_authenticator_data')
  }

  const actualRpIdHash = authDataBuf.subarray(0, 32)
  if (!actualRpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rp_id_hash_mismatch')
  }

  const flags = authDataBuf[32]!
  const userPresent = (flags & 0x01) !== 0
  if (!userPresent) {
    throw new Error('user_not_present')
  }

  const newSignCount = authDataBuf.readUInt32BE(33)

  // Consume challenge atomically OUTSIDE tx so failed signature checks never restore a spent challenge
  const consumed = await db.query<{
    challenge: string
    expires_at: string
    user_id: string | null
  }>(
    `DELETE FROM auth_challenges
     WHERE challenge = $1 AND kind = 'login' AND method = 'passkey'
     RETURNING challenge, expires_at, user_id`,
    [challengeStr],
  )
  if (consumed.rowCount === 0 || !consumed.rows[0]) {
    throw new Error('invalid_or_expired_challenge')
  }
  const chRow = consumed.rows[0]
  if (new Date(chRow.expires_at).getTime() < Date.now()) {
    throw new Error('challenge_expired')
  }

  let authenticatedUser: AuthenticatedPasskeyUser | null = null

  await db.tx(async (txClient) => {
    // 1. Lookup credential by body.id or body.rawId
    const credIdQuery = body.id || body.rawId || ''
    const credRes = await txClient.query<{
      id: string
      user_id: string
      public_key: string
      algorithm: number
      sign_count: string | number
      u_id: string
      u_username: string
      u_email: string | null
      u_display_name: string
      u_roles: Role[] | string
      u_disabled: boolean
    }>(
      `SELECT c.id, c.user_id, c.public_key, c.algorithm, c.sign_count,
              u.id as u_id, u.username as u_username, u.email as u_email,
              u.display_name as u_display_name, u.roles as u_roles, u.disabled as u_disabled
       FROM auth_credentials c
       JOIN auth_users u ON c.user_id = u.id
       WHERE c.credential_id = $1 AND c.method = 'passkey'`,
      [credIdQuery],
    )

    if (credRes.rowCount === 0 || !credRes.rows[0]) {
      throw new Error('credential_not_found')
    }
    const cred = credRes.rows[0]
    if (cred.u_disabled) {
      throw new Error('account_disabled')
    }

    if (chRow.user_id && chRow.user_id !== cred.user_id) {
      throw new Error('challenge_user_mismatch')
    }

    // 3. Anti-replay check on sign_count
    const storedSignCount = Number(cred.sign_count)
    if (storedSignCount > 0 && newSignCount <= storedSignCount) {
      throw new Error('sign_count_anti_replay')
    }

    // 4. Verify cryptographic signature
    const clientDataHash = createHash('sha256').update(clientDataBuf).digest()
    const signedData = Buffer.concat([authDataBuf, clientDataHash])
    const signatureBuf = Buffer.from(body.response.signature, 'base64url')

    const verifier = createVerify('SHA256')
    verifier.update(signedData)
    const keyObj = createPublicKey(cred.public_key)
    const valid = verifier.verify(keyObj, signatureBuf)
    if (!valid) {
      throw new Error('invalid_signature')
    }

    // 5. Update sign_count and last_used_at
    await txClient.query(
      `UPDATE auth_credentials SET sign_count = $1, last_used_at = NOW() WHERE id = $2`,
      [newSignCount, cred.id],
    )
    await txClient.query(`UPDATE auth_users SET last_login_at = NOW() WHERE id = $1`, [
      cred.user_id,
    ])

    let roles: Role[]
    if (Array.isArray(cred.u_roles)) {
      roles = cred.u_roles as Role[]
    } else if (typeof cred.u_roles === 'string') {
      try {
        roles = JSON.parse(cred.u_roles) as Role[]
      } catch {
        roles = ['reader']
      }
    } else {
      roles = ['reader']
    }
    if (!roles.includes('reader')) {
      roles = ['reader', ...roles]
    }

    authenticatedUser = {
      id: cred.u_id,
      username: cred.u_username,
      email: cred.u_email,
      displayName: cred.u_display_name,
      roles,
    }
  })

  if (!authenticatedUser) {
    throw new Error('authentication_failed')
  }

  return { ok: true, user: authenticatedUser }
}
