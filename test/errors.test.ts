import { describe, expect, it } from 'vitest'
import { ApiError, SchemaDriftError } from '../src/errors.js'
import { redactText } from '../src/redact.js'

/*
 * Errors keep response bodies for diagnosis, and Node's default printer shows every
 * field of an uncaught error. A drift on `/me` therefore used to print the live JWT.
 * These pin that the credential is masked when the error is built, not when printed.
 */

/** Built at runtime so no credential-shaped literal sits in the repo. */
function fakeJwt(): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ address: '0xabc' })}.fake-signature`
}
const JWT = fakeJwt()

describe('credential redaction in errors', () => {
  it('masks the token and intercomUserJwt in a SchemaDriftError raw body', () => {
    const drift = new SchemaDriftError({
      endpoint: '/me',
      issues: [],
      raw: { token: JWT, intercomUserJwt: 'opaque-intercom-value', unexpected: 1 },
    })
    expect(drift.raw).not.toContain(JWT)
    expect(drift.raw).not.toContain('opaque-intercom-value')
    // The shape stays diagnosable.
    expect(drift.raw).toContain('"unexpected":1')
  })

  it('masks a JWT in a raw string body too', () => {
    const drift = new SchemaDriftError({ endpoint: '/me', issues: [], raw: `{"token":"${JWT}"` })
    expect(drift.raw).not.toContain(JWT)
  })

  it('masks credentials in an ApiError body, keeping the fields callers branch on', () => {
    const err = new ApiError({
      message: 'nope',
      status: 422,
      endpoint: '/auth/switch',
      body: { error_code: 'x', token: JWT, nested: { cookies: 'vr-token=abc' } },
    })
    const printed = JSON.stringify(err.body)
    expect(printed).not.toContain(JWT)
    expect(printed).not.toContain('vr-token=abc')
    expect((err.body as { error_code: string }).error_code).toBe('x')
  })

  it('masks cookie headers and vr-* cookies in free text', () => {
    expect(redactText('cookie: vr-token=abc; _ga=1')).toBe('cookie: ***')
    expect(redactText('sent vr-token=abc; vr-connected-address=0x1')).toBe(
      'sent vr-token=***; vr-connected-address=***',
    )
  })
})
