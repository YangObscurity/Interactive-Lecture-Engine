import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

export const SCRYPT_N = 16384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const KEYLEN = 64
export const SALT_BYTES = 16
export const MAX_PASSWORD_LEN = 256

const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a)
const DUMMY_HASH = Buffer.alloc(KEYLEN, 0xa5)

export class PasswordValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasswordValidationError'
  }
}

export function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string') {
    throw new PasswordValidationError('Password must be a string')
  }
  if (password.length < 8 || password.length > MAX_PASSWORD_LEN) {
    throw new PasswordValidationError(`Password must be between 8 and ${MAX_PASSWORD_LEN} characters`)
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordStrength(password)
  const salt = randomBytes(SALT_BYTES)
  const derivedKey = (await scryptAsync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 32 * 1024 * 1024,
  })) as Buffer

  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derivedKey.toString('hex')}`
}

export async function dummyVerifyPassword(): Promise<boolean> {
  const derivedKey = (await scryptAsync('dummy_password_for_timing', DUMMY_SALT, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 32 * 1024 * 1024,
  })) as Buffer
  timingSafeEqual(derivedKey, DUMMY_HASH)
  return false
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LEN ||
    !storedHash ||
    typeof storedHash !== 'string'
  ) {
    await dummyVerifyPassword()
    return false
  }

  const parts = storedHash.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await dummyVerifyPassword()
    return false
  }

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const saltHex = parts[4]
  const hashHex = parts[5]

  if (!saltHex || !hashHex || Number.isNaN(n) || Number.isNaN(r) || Number.isNaN(p)) {
    await dummyVerifyPassword()
    return false
  }

  const salt = Buffer.from(saltHex, 'hex')
  const expectedHash = Buffer.from(hashHex, 'hex')

  if (salt.length === 0 || expectedHash.length !== KEYLEN) {
    await dummyVerifyPassword()
    return false
  }

  const derivedKey = (await scryptAsync(password, salt, expectedHash.length, {
    N: n,
    r: r,
    p: p,
    maxmem: 32 * 1024 * 1024,
  })) as Buffer

  if (derivedKey.length !== expectedHash.length) {
    return false
  }

  return timingSafeEqual(derivedKey, expectedHash)
}
