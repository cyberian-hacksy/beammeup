// Trigger a browser download for an in-memory Blob via a temporary anchor.
// Shared by the QR, CIMBAR, and HDMI-UVC receivers, which each build the Blob
// their own way. Appends to the body (some browsers ignore clicks on detached
// anchors) and revokes the object URL on a delay (immediate revoke can abort
// the download in Safari).
export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
