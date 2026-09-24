/**
 * A venue session in portable form: what `mintSessionViaSiwe` returns and what a
 * transport needs to act as the logged-in account. Serialise it to move a session
 * between processes or machines — and treat it like a password while you do.
 */
export type SessionBundle = {
  /** The JWT from GET /me, used verbatim as the WS claims frame. */
  token: string
  /** Serialised cookie jar. Carries the real session. */
  cookies?: string
  address?: string
  userAgent?: string
  /** Epoch ms; taken from the JWT `exp` claim when not supplied. */
  expiresAt?: number
}
