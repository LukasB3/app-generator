import { crc32, deflateSync, inflateSync } from 'node:zlib'

// The picture of a page comes out of the container the page ran in, so it is
// hostile data like everything else from there. It is never passed on. It is
// taken apart, checked to be exactly the picture that was asked for, and
// written anew: a header, the pixel rows compressed here, and an end.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 }

export interface Picture {
  width: number
  height: number
  channels: number
  // The rows as the file holds them: one filter byte, then the filtered bytes.
  rows: Buffer
}

// Reads a PNG of exactly this size, 8 bits per channel, RGB or RGBA, not
// interlaced. Anything else, or anything odd about the file, gives null.
export const readPng = (bytes: Buffer, width: number, height: number): Picture | null => {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null
  let at = 8
  let channels = 0
  let ended = false
  const data: Buffer[] = []
  while (at < bytes.length) {
    if (ended || at + 12 > bytes.length) return null
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const end = at + 12 + length
    if (end > bytes.length) return null
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(end - 4)) return null
    if (at === 8) {
      if (type !== 'IHDR' || length !== 13) return null
      if (body.readUInt32BE(0) !== width || body.readUInt32BE(4) !== height) return null
      channels = CHANNELS[body[9]!] ?? 0
      // Bit depth 8, deflate, the standard filters, no interlacing.
      if (!channels || body[8] !== 8 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return null
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') ended = true
    // Chunks a decoder may ignore (lower-case first letter) are dropped. Any other is not expected here.
    else if (type[0]! < 'a') return null
    at = end
  }
  if (!ended || !data.length) return null
  const expected = height * (1 + width * channels)
  let rows: Buffer
  try {
    rows = inflateSync(Buffer.concat(data), { maxOutputLength: expected })
  } catch {
    return null
  }
  if (rows.length !== expected) return null
  for (let row = 0; row < height; row++) if (rows[row * (1 + width * channels)]! > 4) return null
  return { width, height, channels, rows }
}

const chunk = (type: string, body: Buffer) => {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

export const writePng = ({ width, height, channels, rows }: Picture) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// The colours of the picture, row after row, with the filters undone.
export const pixels = ({ width, height, channels, rows }: Picture) => {
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = rows[row * (stride + 1)]!
    const from = row * (stride + 1) + 1
    const to = row * stride
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[to + i - channels]! : 0
      const up = row ? out[to + i - stride]! : 0
      const corner = row && i >= channels ? out[to + i - stride - channels]! : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - corner
        const nearLeft = Math.abs(p - left)
        const nearUp = Math.abs(p - up)
        const nearCorner = Math.abs(p - corner)
        predicted = nearLeft <= nearUp && nearLeft <= nearCorner ? left : nearUp <= nearCorner ? up : corner
      }
      out[to + i] = (rows[from + i]! + predicted) & 0xff
    }
  }
  return out
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

// Whether the picture shows nothing: no edge anywhere, only one colour or a
// smooth run of colours. The box, where our own notice sits, is left out.
export const featureless = (picture: Picture, except?: Box | null) => {
  const { width, height, channels } = picture
  const colours = pixels(picture)
  const stride = width * channels
  const skipped = (x: number, y: number) => except != null && x >= except.x && x < except.x + except.width && y >= except.y && y < except.y + except.height
  const differs = (a: number, b: number) => {
    for (let c = 0; c < 3; c++) if (Math.abs(colours[a + c]! - colours[b + c]!) > 12) return true
    return false
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (skipped(x, y)) continue
      const here = y * stride + x * channels
      if (x + 1 < width && !skipped(x + 1, y) && differs(here, here + channels)) return false
      if (y + 1 < height && !skipped(x, y + 1) && differs(here, here + stride)) return false
    }
  return true
}
