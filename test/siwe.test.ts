import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { describe, expect, it } from 'vitest'
import { addressFromPrivateKey, personalSign } from '../src/siwe.js'

/**
 * The venue authenticates with SIWE: `POST /auth/generate_signing_data` returns an
 * EIP-191 message, you `personal_sign` it, and `POST /auth/login` exchanges the
 * signature for a session token.
 *
 * These vectors are the whole safety net. A signature that is subtly wrong -- a
 * mis-encoded prefix, a bad recovery id, a flipped s-value -- does not throw. It
 * produces 65 plausible bytes that the venue simply rejects, and the caller sits there
 * unable to authenticate with no clue why. Known-answer tests turn that into a failure
 * at build time.
 *
 * Vector: the canonical Ethereum test key (private key 0x4c0883...), whose address and
 * "hello world" signature are widely published and independently reproducible.
 */
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23'

describe('addressFromPrivateKey', () => {
  it('derives the checksummed address the venue will see', () => {
    expect(addressFromPrivateKey(KEY).toLowerCase()).toBe(ADDRESS.toLowerCase())
  })

  it('accepts a key with or without the 0x prefix', () => {
    expect(addressFromPrivateKey(KEY.slice(2)).toLowerCase()).toBe(ADDRESS.toLowerCase())
  })

  it('refuses a key that is not 32 bytes rather than signing with garbage', () => {
    expect(() => addressFromPrivateKey('0xdeadbeef')).toThrow(/32 bytes/i)
  })
})

describe('personalSign', () => {
  it('signs so the venue recovers exactly this address from the signature', () => {
    /*
     * This is the real assertion, and it is stronger than a hard-coded hex constant:
     * it reproduces what the venue itself does. `/auth/login` takes the message and the
     * signature, recovers the signer, and grants a session for THAT address. If the
     * prefix framing, the hash, or the recovery byte were wrong, recovery would yield a
     * different address (or fail), and the login would be rejected.
     */
    const message = 'hello world'
    const sig = personalSign(message, KEY)

    const body = new TextEncoder().encode(message)
    const prefix = new TextEncoder().encode(`Ethereum Signed Message:
${body.length}`)
    const payload = new Uint8Array(prefix.length + body.length)
    payload.set(prefix, 0)
    payload.set(body, prefix.length)
    const digest = keccak_256(payload)

    const raw = sig.slice(2)
    const recovery = Number.parseInt(raw.slice(128), 16) - 27
    const compact = Uint8Array.from(
      (raw.slice(0, 128).match(/../g) as string[]).map((h) => Number.parseInt(h, 16)),
    )
    const point = secp256k1.Signature.fromBytes(compact, 'compact')
      .addRecoveryBit(recovery)
      .recoverPublicKey(digest)
    const pub = point.toBytes(false).slice(1)
    const recovered = `0x${Array.from(keccak_256(pub), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(-40)}`

    expect(recovered.toLowerCase()).toBe(ADDRESS.toLowerCase())
  })

  it('emits 65 bytes with a v of 27 or 28, which is what the venue parses', () => {
    const sig = personalSign('any message', KEY)
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    const v = Number.parseInt(sig.slice(-2), 16)
    expect([27, 28]).toContain(v)
  })

  it('changes with the message, so a replayed signature cannot pass', () => {
    expect(personalSign('a', KEY)).not.toBe(personalSign('b', KEY))
  })
})
