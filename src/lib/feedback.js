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

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API unavailable (iOS WebViews, insecure contexts): fall back
    // to the hidden-textarea execCommand trick.
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

// Copy text to the clipboard, narrating the outcome on the button that
// triggered it (Copying… → Copied!/Copy failed → idle after 1.5s).
export async function copyWithButtonFeedback(btn, text, { idleText = 'Copy' } = {}) {
  if (!text) return
  btn.textContent = 'Copying…'
  const ok = await copyTextToClipboard(text)
  btn.textContent = ok ? 'Copied!' : 'Copy failed'
  setTimeout(() => { btn.textContent = idleText }, 1500)
}

// Visual cue that a control's value was changed programmatically. The CSS
// animation carries the fade; under prefers-reduced-motion the animation is
// collapsed and .preset-flash renders as a steady highlight instead, so the
// class must be removed on a timer either way.
const flashTimers = new WeakMap()

export function flashHighlight(el) {
  if (!el) return
  el.classList.remove('preset-flash')
  void el.offsetWidth // restart the animation on back-to-back changes
  el.classList.add('preset-flash')
  clearTimeout(flashTimers.get(el))
  flashTimers.set(el, setTimeout(() => el.classList.remove('preset-flash'), 1200))
}
