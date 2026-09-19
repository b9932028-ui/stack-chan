import { applyNeutralPose } from 'capsule-face-animations/shared'
import { drawPixelRows, drawPixelText, staticPixelEffect } from 'capsule-face-animations/static-pixel-effect'

const DURATION_MS = 6000

const logo = Object.freeze([
  'rrrrrrr.ggggggg',
  'rrrrrrr.ggggggg',
  'rrrrrrr.ggggggg',
  'rrrrrrr.ggggggg',
  'rrrrrrr.ggggggg',
  'rrrrrrr.ggggggg',
  'rrrrrrr.ggggggg',
  '...............',
  'bbbbbbb.yyyyyyy',
  'bbbbbbb.yyyyyyy',
  'bbbbbbb.yyyyyyy',
  'bbbbbbb.yyyyyyy',
  'bbbbbbb.yyyyyyy',
  'bbbbbbb.yyyyyyy',
  'bbbbbbb.yyyyyyy',
])

const logoColors = Object.freeze({ r: '#f25022', g: '#7fba00', b: '#00a4ef', y: '#ffb900' })

export const MicrosoftEffect = staticPixelEffect('microsoft', (port) => {
  // 90 px logo and 42 px text are independently centered on the screen's vertical axis.
  drawPixelRows(port, logo, logoColors, 28, 75, 6)
  drawPixelText(port, '600^', '#ef4444', 174, 99, 6)
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face) {
    applyNeutralPose(face)
  },
})
