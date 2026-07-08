// Rolling perf-window accumulator (count/sum/min/max) shared by the sender
// and receiver perf modules.

export function createPerfWindow() {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0
  }
}

export function resetPerfWindow(window) {
  window.count = 0
  window.sum = 0
  window.min = Infinity
  window.max = 0
}

export function recordPerfSample(window, value) {
  if (!Number.isFinite(value)) return
  window.count++
  window.sum += value
  if (value < window.min) window.min = value
  if (value > window.max) window.max = value
}

export function averagePerfWindow(window) {
  return window.count > 0 ? window.sum / window.count : 0
}
