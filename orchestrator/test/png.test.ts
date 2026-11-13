import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { featureless, pixels, readPng, writePng, type Picture } from '../src/png.js'

// A picture as headless Chrome wrote it: the "clean" fixture app at 390×844,
// a white page with a red block at (20, 300), 100 wide and high.
const fromChrome = readFileSync(join(import.meta.dirname, 'fixtures/page-390x844.png'))

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, body: Buffer, checksum?: number) => {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(checksum ?? crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}
const header = (width: number, height: number, { depth = 8, colour = 2, interlace = 0 } = {}) => {
  const body = Buffer.alloc(13)
  body.writeUInt32BE(width, 0)
  body.writeUInt32BE(height, 4)
  body[8] = depth
  body[9] = colour
  body[12] = interlace
  return chunk('IHDR', body)
}
// A 4×2 picture in RGB: every row a filter byte and twelve bytes of colour.
const rows = Buffer.alloc(2 * 13, 200)
rows[0] = rows[13] = 0
const png = (...chunks: Buffer[]) => Buffer.concat([SIGNATURE, ...chunks])
const good = () => png(header(4, 2), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)))
const plain = (width: number, height: number, colour: [number, number, number]): Picture => {
  const out = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set(colour, y * (1 + width * 3) + 1 + x * 3)
  return { width, height, channels: 3, rows: out }
}
const paint = (picture: Picture, x: number, y: number, colour: [number, number, number]) => picture.rows.set(colour, y * (1 + picture.width * 3) + 1 + x * 3)

describe('reading the picture of a page', () => {
  it('reads what Chrome wrote, colours included', () => {
    const picture = readPng(fromChrome, 390, 844)!
    expect(picture).not.toBeNull()
    const colours = pixels(picture)
    const at = (x: number, y: number) => [...colours.subarray((y * 390 + x) * picture.channels, (y * 390 + x) * picture.channels + 3)]
    expect(at(30, 310)).toEqual([255, 0, 0])
    expect(at(119, 399)).toEqual([255, 0, 0])
    expect(at(121, 401)).toEqual([255, 255, 255])
    expect(at(300, 700)).toEqual([255, 255, 255])
  })

  it('writes a new file with the same picture in it', () => {
    const picture = readPng(fromChrome, 390, 844)!
    const rebuilt = writePng(picture)
    expect(rebuilt.equals(fromChrome)).toBe(false)
    expect(pixels(readPng(rebuilt, 390, 844)!).equals(pixels(picture))).toBe(true)
    // Header, one block of pixels, end: nothing else Chrome or a page put into the file comes along.
    expect(rebuilt.toString('latin1').match(/IHDR|IDAT|IEND|tEXt|iTXt|zTXt|eXIf|iCCP|sRGB/g)).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('accepts a small well-formed file', () => {
    expect(readPng(good(), 4, 2)).toMatchObject({ width: 4, height: 2, channels: 3 })
  })

  it.each([
    ['a picture of another size', () => readPng(good(), 4, 3)],
    ['a file that is not a PNG', () => readPng(Buffer.from('<html>'.repeat(20)), 4, 2)],
    ['a wrong checksum', () => readPng(png(header(4, 2), chunk('IDAT', deflateSync(rows), 1), chunk('IEND', Buffer.alloc(0))), 4, 2)],
    ['bytes after the end', () => readPng(Buffer.concat([good(), Buffer.from('more')]), 4, 2)],
    ['a chunk after the end', () => readPng(png(header(4, 2), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)), chunk('IDAT', deflateSync(rows))), 4, 2)],
    ['no end', () => readPng(png(header(4, 2), chunk('IDAT', deflateSync(rows))), 4, 2)],
    ['an unknown chunk that must not be ignored', () => readPng(png(header(4, 2), chunk('XTRA', Buffer.from('x')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))), 4, 2)],
    ['sixteen bits per channel', () => readPng(png(header(4, 2, { depth: 16 }), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))), 4, 2)],
    ['a palette picture', () => readPng(png(header(4, 2, { colour: 3 }), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))), 4, 2)],
    ['an interlaced picture', () => readPng(png(header(4, 2, { interlace: 1 }), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))), 4, 2)],
    ['fewer pixels than the header promises', () => readPng(png(header(4, 2), chunk('IDAT', deflateSync(rows.subarray(0, 13))), chunk('IEND', Buffer.alloc(0))), 4, 2)],
    ['a filter that does not exist', () => readPng(png(header(4, 2), chunk('IDAT', deflateSync(Buffer.from(rows).fill(9, 0, 1))), chunk('IEND', Buffer.alloc(0))), 4, 2)],
  ])('refuses %s', (_name, read) => {
    expect(read()).toBeNull()
  })

  it('stops at the size it expects, however much the file unpacks to', () => {
    // A hundred megabytes of zeros pack into a hundred kilobytes.
    const bomb = png(header(4, 2), chunk('IDAT', deflateSync(Buffer.alloc(100_000_000))), chunk('IEND', Buffer.alloc(0)))
    expect(bomb.length).toBeLessThan(200_000)
    expect(readPng(bomb, 4, 2)).toBeNull()
  })

  it('drops chunks a reader may ignore', () => {
    const withText = png(header(4, 2), chunk('tEXt', Buffer.from('Comment\0hello')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)))
    expect(writePng(readPng(withText, 4, 2)!).includes('hello')).toBe(false)
  })
})

describe('telling an empty picture from one that shows something', () => {
  it('calls one colour empty', () => {
    expect(featureless(plain(40, 30, [255, 255, 255]))).toBe(true)
  })

  it('calls a smooth run of colours empty', () => {
    const picture = plain(40, 30, [0, 0, 0])
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) paint(picture, x, y, [x * 6, y * 8, 120])
    expect(featureless(picture)).toBe(true)
  })

  it('sees a single dark dot on a light page', () => {
    const picture = plain(40, 30, [255, 255, 255])
    paint(picture, 17, 11, [20, 20, 20])
    expect(featureless(picture)).toBe(false)
  })

  it('leaves out the box where our own notice sits', () => {
    const picture = plain(40, 30, [255, 255, 255])
    for (let y = 20; y < 26; y++) for (let x = 10; x < 30; x++) paint(picture, x, y, [17, 17, 17])
    expect(featureless(picture)).toBe(false)
    expect(featureless(picture, { x: 10, y: 20, width: 20, height: 6 })).toBe(true)
  })

  it('finds the page Chrome drew not empty', () => {
    expect(featureless(readPng(fromChrome, 390, 844)!)).toBe(false)
  })
})
