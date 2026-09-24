/**
 * Host-permission checks.
 *
 * The manifest asks for the bare minimum up front (`cookies`, `storage`,
 * `alarms`, and the venue host). The only optional grant is the push server's
 * own origin, which the user approves from the popup, on a user gesture, and
 * only if they turn push on.
 */

export async function hasOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] })
  } catch {
    return false
  }
}
