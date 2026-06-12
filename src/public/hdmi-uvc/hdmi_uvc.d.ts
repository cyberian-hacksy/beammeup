declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  /**
   * wasm/hdmi-uvc/src/index/crc32
   * @param ptr `u32`
   * @param len `u32`
   * @returns `u32`
   */
  export function crc32(ptr: number, len: number): number;
  /**
   * wasm/hdmi-uvc/src/index/getScratchStart
   * @returns `u32`
   */
  export function getScratchStart(): number;
  /**
   * wasm/hdmi-uvc/src/index/getMemorySize
   * @returns `i32`
   */
  export function getMemorySize(): number;
  /**
   * wasm/hdmi-uvc/src/index/growMemory
   * @param pages `i32`
   * @returns `i32`
   */
  export function growMemory(pages: number): number;
  /**
   * wasm/hdmi-uvc/src/index/classifyCompat4Cells
   * @param pixelsPtr `u32`
   * @param width `u32`
   * @param height `u32`
   * @param cellsPtr `u32`
   * @param cellCount `u32`
   * @param outPtr `u32`
   * @returns `u32`
   */
  export function classifyCompat4Cells(pixelsPtr: number, width: number, height: number, cellsPtr: number, cellCount: number, outPtr: number): number;
  /**
   * wasm/hdmi-uvc/src/index/classifyLuma2Cells
   * @param pixelsPtr `u32`
   * @param width `u32`
   * @param height `u32`
   * @param cellsPtr `u32`
   * @param cellCount `u32`
   * @param outPtr `u32`
   * @returns `u32`
   */
  export function classifyLuma2Cells(pixelsPtr: number, width: number, height: number, cellsPtr: number, cellCount: number, outPtr: number): number;
  /**
   * wasm/hdmi-uvc/src/index/packBinary1Payload
   * @param pixelsPtr `u32`
   * @param width `u32`
   * @param height `u32`
   * @param rowStartsPtr `u32`
   * @param thresholdsPtr `u32`
   * @param payloadCellsX `u32`
   * @param payloadCellsY `u32`
   * @param payloadLength `u32`
   * @param outPtr `u32`
   * @returns `u32`
   */
  export function packBinary1Payload(pixelsPtr: number, width: number, height: number, rowStartsPtr: number, thresholdsPtr: number, payloadCellsX: number, payloadCellsY: number, payloadLength: number, outPtr: number): number;
  /**
   * wasm/hdmi-uvc/src/index/readLuma1Payload
   * @param pixelsPtr `u32`
   * @param width `u32`
   * @param height `u32`
   * @param rowStartsPtr `u32`
   * @param rowParamsPtr `u32`
   * @param payloadCellsX `u32`
   * @param payloadCellsY `u32`
   * @param payloadLength `u32`
   * @param pixelStep `u32`
   * @param lambda `f64`
   * @param workPtr `u32`
   * @param outPtr `u32`
   * @returns `u32`
   */
  export function readLuma1Payload(pixelsPtr: number, width: number, height: number, rowStartsPtr: number, rowParamsPtr: number, payloadCellsX: number, payloadCellsY: number, payloadLength: number, pixelStep: number, lambda: number, workPtr: number, outPtr: number): number;
  /**
   * wasm/hdmi-uvc/src/index/probeExpectedPackets
   * @param framePtr `u32`
   * @param frameLength `u32`
   * @param packetSize `u32`
   * @param fileIdFilter `u32`
   * @param kFilter `u32`
   * @param filterFlags `u32`
   * @param outPtr `u32`
   * @param maxSlots `u32`
   * @returns `u32`
   */
  export function probeExpectedPackets(framePtr: number, frameLength: number, packetSize: number, fileIdFilter: number, kFilter: number, filterFlags: number, outPtr: number, maxSlots: number): number;
  /**
   * wasm/hdmi-uvc/src/index/scanBrightRuns
   * @param pixelsPtr `u32`
   * @param width `u32`
   * @param height `u32`
   * @param xStart `u32`
   * @param xEnd `u32`
   * @param yStart `i32`
   * @param yEnd `i32`
   * @param yDir `i32`
   * @param minRun `u32`
   * @param maxRun `u32`
   * @param threshold `u32`
   * @param outPtr `u32`
   * @param maxRuns `u32`
   * @returns `u32`
   */
  export function scanBrightRuns(pixelsPtr: number, width: number, height: number, xStart: number, xEnd: number, yStart: number, yEnd: number, yDir: number, minRun: number, maxRun: number, threshold: number, outPtr: number, maxRuns: number): number;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
}): Promise<typeof __AdaptedExports>;
