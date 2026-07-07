// Audio and screen-reader feedback helpers shared by the receiver modules.

// One AudioContext for the whole session; creating one per beep leaks
// contexts and iOS caps how many a page may hold.
let audioCtx = null

export function playBeep(frequency = 800, duration = 150) {
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const oscillator = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    oscillator.connect(gain)
    gain.connect(audioCtx.destination)
    oscillator.frequency.value = frequency
    gain.gain.value = 0.3
    oscillator.start()
    oscillator.stop(audioCtx.currentTime + duration / 1000)
  } catch (err) {
    // Audio may be unavailable; feedback is best-effort.
  }
}

// Announce a state change to screen readers via the polite live region in
// index.html. Progress percentages update too often to announce; reserve this
// for transitions (transfer started, transfer complete, presets adjusted).
export function announce(message) {
  const el = typeof document !== 'undefined' ? document.getElementById('sr-announce') : null
  if (el) el.textContent = message
}
