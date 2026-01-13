// CIMBAR WASM lazy loader
let wasmModule = null
let loadPromise = null

// Determine base path for CIMBAR assets
function getBasePath() {
  // Get base from document location
  const base = document.baseURI || window.location.href
  const url = new URL(base)
  // Remove filename if present (e.g., index.html)
  let path = url.pathname
  if (path.endsWith('.html')) {
    path = path.substring(0, path.lastIndexOf('/') + 1)
  } else if (!path.endsWith('/')) {
    path += '/'
  }
  return path + 'cimbar/'
}

export function loadCimbarWasm() {
  if (wasmModule) {
    return Promise.resolve(wasmModule)
  }

  if (loadPromise) {
    return loadPromise
  }

  const basePath = getBasePath()
  console.log('CIMBAR loading from:', basePath)

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
          return basePath + 'cimbar_js.wasm'
        }
        return path
      },
      onRuntimeInitialized: () => {
        console.log('CIMBAR WASM initialized')
        wasmModule = window.Module
        resolve(wasmModule)
      }
    }

    // Load the WASM glue script
    const script = document.createElement('script')
    script.src = basePath + 'cimbar_js.js'
    script.onerror = (e) => {
      console.error('Failed to load CIMBAR script from:', script.src, e)
      loadPromise = null
      reject(new Error('Failed to load CIMBAR WASM script from ' + script.src))
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
  // VideoFrame is optional - we have canvas fallback for iOS

  return {
    compatible: issues.length === 0,
    issues
  }
}
