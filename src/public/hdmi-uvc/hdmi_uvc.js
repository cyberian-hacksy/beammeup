export async function instantiate(module, imports = {}) {
  const { exports } = await WebAssembly.instantiate(module, imports);
  const memory = exports.memory || imports.env.memory;
  const adaptedExports = Object.setPrototypeOf({
    crc32(ptr, len) {
      // wasm/hdmi-uvc/src/index/crc32(u32, u32) => u32
      return exports.crc32(ptr, len) >>> 0;
    },
    getScratchStart() {
      // wasm/hdmi-uvc/src/index/getScratchStart() => u32
      return exports.getScratchStart() >>> 0;
    },
    classifyCompat4Cells(pixelsPtr, width, height, cellsPtr, cellCount, outPtr) {
      // wasm/hdmi-uvc/src/index/classifyCompat4Cells(u32, u32, u32, u32, u32, u32) => u32
      return exports.classifyCompat4Cells(pixelsPtr, width, height, cellsPtr, cellCount, outPtr) >>> 0;
    },
    classifyLuma2Cells(pixelsPtr, width, height, cellsPtr, cellCount, outPtr) {
      // wasm/hdmi-uvc/src/index/classifyLuma2Cells(u32, u32, u32, u32, u32, u32) => u32
      return exports.classifyLuma2Cells(pixelsPtr, width, height, cellsPtr, cellCount, outPtr) >>> 0;
    },
    scanBrightRuns(pixelsPtr, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold, outPtr, maxRuns) {
      // wasm/hdmi-uvc/src/index/scanBrightRuns(u32, u32, u32, u32, u32, i32, i32, i32, u32, u32, u32, u32, u32) => u32
      return exports.scanBrightRuns(pixelsPtr, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold, outPtr, maxRuns) >>> 0;
    },
  }, exports);
  return adaptedExports;
}
