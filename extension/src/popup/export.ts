/**
 * Copy / Download for the popup.
 *
 * Neither needs a manifest permission: an extension page may write the clipboard
 * on a user gesture, and a `download` anchor pointing at a blob URL saves a file
 * without the `downloads` API. The browser APIs are injected so both paths are
 * testable without a DOM.
 *
 * Both must run straight off the click handler, with the bundle already in
 * memory: the clipboard write needs the click's transient user activation, which
 * a network round-trip first could outlive.
 */

import { type SessionBundle, serializeBundle, serializeBundleOneLine } from '../shared/bundle.js'
import { SESSION_FILE_NAME } from '../shared/constants.js'

export interface ClipboardLike {
  writeText(text: string): Promise<void>
}

export async function copyBundle(bundle: SessionBundle, clipboard: ClipboardLike): Promise<void> {
  await clipboard.writeText(serializeBundleOneLine(bundle))
}

export interface AnchorLike {
  href: string
  download: string
  rel: string
  click(): void
}

export interface DownloadEnv {
  createAnchor(): AnchorLike
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  /** Defers revocation until the browser has started reading the blob. */
  defer(fn: () => void): void
}

export function downloadBundle(bundle: SessionBundle, env: DownloadEnv): void {
  const blob = new Blob([serializeBundle(bundle)], { type: 'application/json' })
  const url = env.createObjectURL(blob)
  const anchor = env.createAnchor()
  anchor.href = url
  anchor.download = SESSION_FILE_NAME
  anchor.rel = 'noopener'
  anchor.click()
  // Revoking synchronously can cancel the download before it starts; the blob
  // would otherwise hold a copy of the credential in memory until the popup closes.
  env.defer(() => env.revokeObjectURL(url))
}

/** The real browser environment, for the popup. */
export function browserDownloadEnv(): DownloadEnv {
  return {
    createAnchor: () => document.createElement('a'),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    defer: (fn) => {
      setTimeout(fn, 1_000)
    },
  }
}
