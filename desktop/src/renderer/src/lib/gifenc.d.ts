// Types for the parts of gifenc (MIT, https://github.com/mattdesl/gifenc) that lib/gifFit.ts uses.
declare module 'gifenc' {
  export type GifPaletteFormat = 'rgb565' | 'rgb444' | 'rgba4444'
  /** [r, g, b] or, for 'rgba4444', [r, g, b, a]. */
  export type GifPalette = number[][]

  export interface QuantizeOptions {
    format?: GifPaletteFormat
    oneBitAlpha?: boolean | number
    clearAlpha?: boolean
    clearAlphaThreshold?: number
    clearAlphaColor?: number
  }
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: QuantizeOptions): GifPalette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPalette, format?: GifPaletteFormat): Uint8Array

  export interface WriteFrameOptions {
    palette?: GifPalette
    /** Milliseconds (stored as centiseconds). */
    delay?: number
    transparent?: boolean
    transparentIndex?: number
    /** -1 = play once, 0 = loop forever, n = loop n times. */
    repeat?: number
    colorDepth?: number
    /** Disposal method override (0-7); -1 = automatic. */
    dispose?: number
    /** Manual mode only: write the logical screen descriptor / global palette first. */
    first?: boolean
  }
  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void
    writeHeader(): void
    finish(): void
    reset(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
  }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance
}
