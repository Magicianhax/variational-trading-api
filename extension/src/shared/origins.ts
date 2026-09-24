/**
 * Which previously granted push-server origins to give back.
 *
 * Chrome keeps an optional host grant until it is removed. Without this, every server
 * URL a user ever saved would stay readable by the extension after they moved on.
 */

/**
 * Granted origins that are neither the venue's (a required permission, which Chrome
 * refuses to remove) nor the push server the settings now point at. `keep` is `null`
 * when push is off, in which case every optional grant is stale.
 */
export function staleOrigins(
  granted: readonly string[],
  keep: string | null,
  required: readonly string[],
): string[] {
  return granted.filter((origin) => origin !== keep && !required.includes(origin))
}
