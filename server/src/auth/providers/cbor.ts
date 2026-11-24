/**
 * Minimal pure-Node CBOR decoder and encoder for WebAuthn (FIDO2) attestation and COSE keys.
 * RFC 8949 compliant for integers, negative integers, byte strings, UTF-8 text strings,
 * arrays, maps, and booleans/null.
 */

const MAX_CBOR_DEPTH = 16

export function cborDecode(buf: Buffer): { value: unknown; bytesRead: number } {
  let offset = 0

  function ensureAvailable(len: number): void {
    if (!Number.isInteger(len) || len < 0 || offset + len > buf.length) {
      throw new Error('Unexpected EOF while decoding CBOR')
    }
  }

  function readUint(info: number): number {
    if (info < 24) return info
    if (info === 24) {
      ensureAvailable(1)
      const v = buf.readUInt8(offset)
      offset += 1
      return v
    }
    if (info === 25) {
      ensureAvailable(2)
      const v = buf.readUInt16BE(offset)
      offset += 2
      return v
    }
    if (info === 26) {
      ensureAvailable(4)
      const v = buf.readUInt32BE(offset)
      offset += 4
      return v
    }
    if (info === 27) {
      ensureAvailable(8)
      const big = buf.readBigUInt64BE(offset)
      offset += 8
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('CBOR integer overflow')
      }
      return Number(big)
    }
    throw new Error(`Unsupported CBOR uint info ${info}`)
  }

  function decodeItem(depth = 0): unknown {
    if (depth > MAX_CBOR_DEPTH) {
      throw new Error('CBOR nesting depth exceeded')
    }
    if (offset >= buf.length) {
      throw new Error('Unexpected EOF while decoding CBOR')
    }
    const byte = buf[offset++]!
    const major = byte >> 5
    const info = byte & 0x1f

    switch (major) {
      case 0: // Unsigned integer
        return readUint(info)
      case 1: // Negative integer: -1 - val
        return -1 - readUint(info)
      case 2: {
        // Byte string
        const len = readUint(info)
        ensureAvailable(len)
        const b = buf.subarray(offset, offset + len)
        offset += len
        return b
      }
      case 3: {
        // Text string
        const len = readUint(info)
        ensureAvailable(len)
        const s = buf.toString('utf8', offset, offset + len)
        offset += len
        return s
      }
      case 4: {
        // Array
        const len = readUint(info)
        if (len > buf.length - offset) {
          throw new Error('Unexpected EOF while decoding CBOR array')
        }
        const a: unknown[] = []
        for (let i = 0; i < len; i++) {
          a.push(decodeItem(depth + 1))
        }
        return a
      }
      case 5: {
        // Map
        const len = readUint(info)
        if (len * 2 > buf.length - offset) {
          throw new Error('Unexpected EOF while decoding CBOR map')
        }
        const m = new Map<unknown, unknown>()
        for (let i = 0; i < len; i++) {
          const k = decodeItem(depth + 1)
          const v = decodeItem(depth + 1)
          m.set(k, v)
        }
        return m
      }
      case 6: {
        // Tagged item
        readUint(info)
        return decodeItem(depth + 1)
      }
      case 7: {
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 23) return undefined
        break
      }
    }
    throw new Error(`Unsupported CBOR major ${major} info ${info}`)
  }

  const value = decodeItem(0)
  return { value, bytesRead: offset }
}

function encodeHeader(major: number, len: number): Buffer {
  const m = major << 5
  if (len < 24) {
    return Buffer.from([m | len])
  }
  if (len <= 0xff) {
    return Buffer.from([m | 24, len])
  }
  if (len <= 0xffff) {
    const b = Buffer.alloc(3)
    b[0] = m | 25
    b.writeUInt16BE(len, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = m | 26
  b.writeUInt32BE(len, 1)
  return b
}

export function cborEncode(val: unknown): Buffer {
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      if (val >= 0) {
        return encodeHeader(0, val)
      } else {
        const n = -1 - val
        return encodeHeader(1, n)
      }
    }
  }
  if (typeof val === 'string') {
    const strBuf = Buffer.from(val, 'utf8')
    const header = encodeHeader(3, strBuf.length)
    return Buffer.concat([header, strBuf])
  }
  if (Buffer.isBuffer(val)) {
    const header = encodeHeader(2, val.length)
    return Buffer.concat([header, val])
  }
  if (Array.isArray(val)) {
    const header = encodeHeader(4, val.length)
    return Buffer.concat([header, ...val.map(cborEncode)])
  }
  if (val instanceof Map) {
    const header = encodeHeader(5, val.size)
    const parts: Buffer[] = [header]
    for (const [k, v] of val.entries()) {
      parts.push(cborEncode(k), cborEncode(v))
    }
    return Buffer.concat(parts)
  }
  if (typeof val === 'object' && val !== null) {
    const entries = Object.entries(val)
    const header = encodeHeader(5, entries.length)
    const parts: Buffer[] = [header]
    for (const [k, v] of entries) {
      parts.push(cborEncode(k), cborEncode(v))
    }
    return Buffer.concat(parts)
  }
  if (val === false) return Buffer.from([0xf4])
  if (val === true) return Buffer.from([0xf5])
  if (val === null) return Buffer.from([0xf6])
  throw new Error(`Cannot encode CBOR for value: ${String(val)}`)
}
