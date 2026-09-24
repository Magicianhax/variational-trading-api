/**
 * SIWE signing for the venue's `/auth/login`.
 *
 * The venue has no API keys -- its trading API is documented as not yet available to
 * any user -- so the only programmatic way in is the same Sign-In-With-Ethereum flow
 * the web app uses: ask for a message, `personal_sign` it, exchange it for a token.
 *
 * Built on @noble/curves and @noble/hashes rather than a wallet SDK: they are the
 * audited primitives the big libraries use underneath, and this file needs exactly two
 * operations. A signature that is subtly wrong does not throw -- it produces 65
 * plausible bytes the venue rejects -- so the known-answer tests beside this file are
 * the real safety net, not the types.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

function normalizeKey(privateKey: string): Uint8Array {
  const hex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('private key must be 32 bytes of hex (64 characters, 0x optional)')
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** EIP-55 checksummed address, which is what the venue echoes back in claims. */
function toChecksum(addrLower: string): string {
  const digest = hex(keccak_256(new TextEncoder().encode(addrLower)))
  let out = '0x'
  for (let i = 0; i < 40; i += 1) {
    const c = addrLower[i] as string
    out += Number.parseInt(digest[i] as string, 16) >= 8 ? c.toUpperCase() : c
  }
  return out
}

/** The address the venue will attribute a signature to. */
export function addressFromPrivateKey(privateKey: string): string {
  const pub = secp256k1.getPublicKey(normalizeKey(privateKey), false).slice(1) // drop 0x04
  return toChecksum(hex(keccak_256(pub)).slice(-40))
}

/**
 * EIP-191 `personal_sign`: keccak256("\x19Ethereum Signed Message:\n" + len + msg),
 * signed with secp256k1, returned as r||s||v with v in {27, 28}.
 */
export function personalSign(message: string, privateKey: string): string {
  const body = new TextEncoder().encode(message)
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`)
  const payload = new Uint8Array(prefix.length + body.length)
  payload.set(prefix, 0)
  payload.set(body, prefix.length)
  // noble v2 returns 65 bytes laid out as [recovery, r(32), s(32)]; Ethereum wants
  // r || s || v with v = recovery + 27, so the recovery byte moves from front to back.
  const sig = secp256k1.sign(keccak_256(payload), normalizeKey(privateKey), {
    prehash: false,
    format: 'recovered',
  })
  const recovery = sig[0] as number
  const rs = hex(sig.slice(1))
  return `0x${rs}${(recovery + 27).toString(16).padStart(2, '0')}`
}
