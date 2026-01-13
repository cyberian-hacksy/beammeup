// CIMBAR WASM lazy loader
let wasmModule = null
let loadPromise = null

export function loadCimbarWasm() {
  if (wasmModule) {
    return Promise.resolve(wasmModule)
  }

  if (loadPromise) {
    return loadPromise
  }

  loadPromise = new Promise((resolve, reject) => {
    // Create an offscreen canvas for WASM to use during init
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = 1024
    tempCanvas.height = 1024

    // Set up Module before loading script
    window.Module = {
      canvas: tempCanvas,
      locateFile: (path) => {
        if (path.endsWith('.wasm')) {
          return '/cimbar/cimbar_js.wasm'
        }
        return path
      },
      onRuntimeInitialized: () => {
        wasmModule = window.Module
        resolve(wasmModule)
      }
    }

    // Load the WASM glue script
    const script = document.createElement('script')
    script.src = '/cimbar/cimbar_js.js'
    script.onerror = () => {
      loadPromise = null
      reject(new Error('Failed to load CIMBAR WASM script'))
    }
    document.head.appendChild(script)
  })

  return loadPromise
}

export function isLoaded() {
  return wasmModule !== null
}

export function getModule() {
  return wasmModule
}

// Check browser compatibility
export function checkCompatibility() {
  const issues = []

  if (typeof WebAssembly === 'undefined') {
    issues.push('WebAssembly not supported')
  }
  if (typeof Worker === 'undefined') {
    issues.push('Web Workers not supported')
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    issues.push('Camera API not supported')
  }
  if (typeof VideoFrame === 'undefined') {
    issues.push('VideoFrame API not supported')
  }

  return {
    compatible: issues.length === 0,
    issues
  }
}
