/**
 * Programmatic login: sign in with the account's Ethereum key and get a session back.
 *
 * The venue publishes no API keys — its trading API is documented as not yet available
 * to any user — so the only programmatic way in is the SIWE handshake the web app itself
 * performs: ask the venue for a message, sign it with the account's key, exchange it for
 * a token. Sessions last about 7 days.
 *
 * This is the ordinary login path, not a way around a challenge: an existing account's
 * login sends no captcha token at all (the Turnstile gate is on new-account creation).
 *
 * The cost is explicit: the private key has to be present wherever this runs, so whoever
 * holds that machine holds the funds. Keep the account's balance to what you are willing
 * to have at risk there. Only an EOA key works; a smart-contract wallet cannot sign this.
 */

import type { SessionBundle } from './session-bundle.js'
import { addressFromPrivateKey, personalSign } from './siwe.js'

/** The slice of OmniClient this needs; narrow so tests need no network. */
type SiweCapableClient = {
  generateSigningData(address: string, transferInitCode?: string): Promise<string>
  login(args: { address: string; signedMessage: string }): Promise<{ token: string }>
  cookies: { serialize(): string }
}

export async function mintSessionViaSiwe(
  client: SiweCapableClient,
  privateKey: string,
): Promise<SessionBundle> {
  // Derive first: an unusable key must fail here, before any request is made.
  const address = addressFromPrivateKey(privateKey)

  /*
   * The message MUST come from the venue. It carries a server-chosen nonce, so a
   * locally-synthesised one produces a perfectly valid signature over the wrong text --
   * which the venue rejects without saying why.
   */
  const message = await client.generateSigningData(address)
  const signedMessage = personalSign(message, privateKey)

  const result = await client.login({ address, signedMessage })
  const token = result.token?.trim() ?? ''
  if (token === '') throw new Error('venue returned no token for a SIWE login')

  const cookies = client.cookies.serialize()
  const bundle: SessionBundle = { token, address }
  if (cookies !== '') bundle.cookies = cookies
  return bundle
}
