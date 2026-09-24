/**
 * Generate the extension icons.
 *
 * Chrome only accepts raster icons, so the four PNGs in `public/icons/` are
 * generated here rather than hand-drawn: a rounded blue tile with a white
 * right-pointing arrow (the session leaving the browser). Pure Node, no image
 * library, so the icons are reproducible from source on any machine.
 *
 * Run with `pnpm icons` inside extension/. The output is committed; this script
 * is not part of the normal build.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'icons')

const SIZES = [16, 32, 48, 128]
const TILE = [0x1f, 0x5f, 0xd8]
const GLYPH = [0xff, 0xff, 0xff]
const SUPERSAMPLE = 4

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1')
  const body = Buffer.concat([typeBytes, data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Rounded-rect coverage test in normalised [0,1] coordinates. */
function inTile(x, y) {
  const r = 0.22
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** Right-pointing arrow: a shaft plus a head. */
function inGlyph(x, y) {
  const shaft = x >= 0.2 && x <= 0.52 && y >= 0.435 && y <= 0.565
  const head = inTriangle(x, y, 0.78, 0.5, 0.46, 0.27, 0.46, 0.73)
  return shaft || head
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const step = 1 / (size * SUPERSAMPLE)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tile = 0
      let glyph = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step
          const y = (py * SUPERSAMPLE + sy + 0.5) * step
          if (inTile(x, y)) tile += 1
          if (inGlyph(x, y)) glyph += 1
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE
      const tileA = tile / samples
      const glyphA = Math.min(glyph / samples, tileA)
      const offset = (py * size + px) * 4
      for (let c = 0; c < 3; c += 1) {
        // Composite the white glyph over the blue tile, then premultiply-free
        // straight alpha for the PNG.
        const base = TILE[c] * tileA
        const value = base * (1 - glyphA) + GLYPH[c] * glyphA
        rgba[offset + c] = tileA > 0 ? Math.round(value / tileA) : 0
      }
      rgba[offset + 3] = Math.round(tileA * 255)
    }
  }
  return encodePng(size, rgba)
}

async function main() {
  await mkdir(outDir, { recursive: true })
  for (const size of SIZES) {
    const png = renderIcon(size)
    await writeFile(join(outDir, `icon-${size}.png`), png)
    console.log(`[extension] wrote icons/icon-${size}.png (${png.length} bytes)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
