// Tests for the per-mode profile table in hdmi-uvc-constants.js.
import {
  HDMI_MODE,
  getModeDataBlockSize,
  getModeBitsPerBlock,
  getModeHeaderBlockSize,
  getModePayloadBlockSize,
  isDenseBinaryMode,
  isDenseLuma1Mode,
  usesBinary1DenseDefaults
} from './hdmi-uvc-constants.js'

// Snapshot of every mode's derived properties, written against the original
// per-property switch implementations so the MODE_PROFILES refactor is pinned.
export function testModeProfileTable() {
  const expected = {
    [HDMI_MODE.RAW_RGB]:    { data: 4, bits: 2, header: 4, payload: 4, dense: false, luma1: false, b1Defaults: false },
    [HDMI_MODE.RAW_GRAY]:   { data: 4, bits: 2, header: 4, payload: 4, dense: false, luma1: false, b1Defaults: false },
    [HDMI_MODE.COMPAT_4]:   { data: 4, bits: 1, header: 4, payload: 4, dense: false, luma1: false, b1Defaults: false },
    [HDMI_MODE.LUMA_2]:     { data: 4, bits: 2, header: 4, payload: 4, dense: false, luma1: false, b1Defaults: false },
    [HDMI_MODE.CODEBOOK_3]: { data: 4, bits: 3, header: 4, payload: 4, dense: false, luma1: false, b1Defaults: false },
    [HDMI_MODE.GLYPH_5]:    { data: 8, bits: 5, header: 8, payload: 8, dense: false, luma1: false, b1Defaults: false },
    [HDMI_MODE.BINARY_3]:   { data: 3, bits: 1, header: 4, payload: 3, dense: true,  luma1: false, b1Defaults: false },
    [HDMI_MODE.BINARY_2]:   { data: 2, bits: 1, header: 4, payload: 2, dense: true,  luma1: false, b1Defaults: false },
    [HDMI_MODE.BINARY_1]:   { data: 1, bits: 1, header: 4, payload: 1, dense: true,  luma1: false, b1Defaults: true },
    [HDMI_MODE.LUMA_1]:     { data: 1, bits: 2, header: 4, payload: 1, dense: true,  luma1: true,  b1Defaults: true }
  }

  let pass = true
  for (const [modeStr, exp] of Object.entries(expected)) {
    const mode = Number(modeStr)
    const got = {
      data: getModeDataBlockSize(mode),
      bits: getModeBitsPerBlock(mode),
      header: getModeHeaderBlockSize(mode),
      payload: getModePayloadBlockSize(mode),
      dense: isDenseBinaryMode(mode),
      luma1: isDenseLuma1Mode(mode),
      b1Defaults: usesBinary1DenseDefaults(mode)
    }
    for (const key of Object.keys(exp)) {
      if (got[key] !== exp[key]) {
        console.log(`Mode profile test: FAIL mode=${mode} ${key} got=${got[key]} expected=${exp[key]}`)
        pass = false
      }
    }
  }

  // Unknown modes (e.g. removed mode 7) must resolve to null / false.
  const unknown = 7
  pass = pass &&
    getModeDataBlockSize(unknown) === null &&
    getModeBitsPerBlock(unknown) === null &&
    getModeHeaderBlockSize(unknown) === null &&
    getModePayloadBlockSize(unknown) === null &&
    isDenseBinaryMode(unknown) === false &&
    isDenseLuma1Mode(unknown) === false &&
    usesBinary1DenseDefaults(unknown) === false

  console.log('Mode profile table test:', pass ? 'PASS' : 'FAIL')
  return pass
}
