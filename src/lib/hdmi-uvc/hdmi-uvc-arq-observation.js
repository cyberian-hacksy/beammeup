export function buildArqPacketObservations(parsedList) {
  return (parsedList || []).filter(Boolean).map(parsed => ({
    fileId: parsed.fileId,
    symbolId: parsed.symbolId,
    isMetadata: !!parsed.isMetadata,
    payload: parsed.isMetadata ? parsed.payload : null
  }))
}
