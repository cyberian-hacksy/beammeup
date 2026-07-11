// Camera plumbing shared by the QR, CIMBAR, and HDMI-UVC receivers. Each
// receiver keeps its own constraints, persistence, and platform quirks; the
// device listing, dropdown building, and cycle-to-next logic live here.

export function isMobileUA() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

export async function listVideoInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(d => d.kind === 'videoinput')
}

// Rebuild a <select> with one option per camera. `decorateLabel(label, cam)`
// lets a caller append annotations (e.g. the HDMI receiver's "(Capture)");
// `selectedId` pre-selects a device.
export function populateCameraSelect(selectEl, cameras, { selectedId = null, decorateLabel = null } = {}) {
  while (selectEl.firstChild) {
    selectEl.removeChild(selectEl.firstChild)
  }
  cameras.forEach((cam, i) => {
    const option = document.createElement('option')
    option.value = cam.deviceId
    let label = cam.label || `Camera ${i + 1}`
    if (decorateLabel) label = decorateLabel(label, cam)
    option.textContent = label
    if (selectedId && cam.deviceId === selectedId) option.selected = true
    selectEl.appendChild(option)
  })
}

// The camera after `currentDeviceId`, wrapping; null when there is no choice.
export function nextCamera(cameras, currentDeviceId) {
  if (!cameras || cameras.length < 2) return null
  const idx = cameras.findIndex(c => c.deviceId === currentDeviceId)
  return cameras[(idx + 1) % cameras.length]
}
