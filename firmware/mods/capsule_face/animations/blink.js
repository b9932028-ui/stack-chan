import { applyNeutralPose, smoothStep } from 'capsule-face-animations/shared'

const SINGLE_BLINK_DURATION_MS = 300
const BLINK_GAP_MS = 300
const SECOND_BLINK_START_MS = SINGLE_BLINK_DURATION_MS + BLINK_GAP_MS
const BLINK_CLOSE_MS = 90
const BLINK_HOLD_MS = 40
const BLINK_OPEN_MS = SINGLE_BLINK_DURATION_MS - BLINK_CLOSE_MS - BLINK_HOLD_MS

function getSingleBlinkOpen(elapsed) {
  if (elapsed < BLINK_CLOSE_MS) return 1 - smoothStep(elapsed / BLINK_CLOSE_MS)
  if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0
  return smoothStep((elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS)
}

function getBlinkOpen(elapsed) {
  if (elapsed < SINGLE_BLINK_DURATION_MS) return getSingleBlinkOpen(elapsed)
  if (elapsed < SECOND_BLINK_START_MS) return 1
  if (elapsed < SECOND_BLINK_START_MS + SINGLE_BLINK_DURATION_MS) {
    return getSingleBlinkOpen(elapsed - SECOND_BLINK_START_MS)
  }
  return 1
}

export default Object.freeze({
  duration: 1000,
  apply(face, elapsed) {
    applyNeutralPose(face, getBlinkOpen(elapsed))
  },
})
