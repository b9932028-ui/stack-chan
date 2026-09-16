import { smoothStep } from 'capsule-face-animations/shared'
import { Emotion } from 'face-state'

const DURATION_MS = 3000
const TRANSITION_MS = 450

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    const progress =
      elapsed < TRANSITION_MS
        ? smoothStep(elapsed / TRANSITION_MS)
        : elapsed > DURATION_MS - TRANSITION_MS
          ? smoothStep((DURATION_MS - elapsed) / TRANSITION_MS)
          : 1

    face.emotion = Emotion.HAPPY
    face.eyes.left.open = progress
    face.eyes.right.open = progress
    face.eyes.left.gazeX = 0
    face.eyes.right.gazeX = 0
    face.eyes.left.gazeY = 0
    face.eyes.right.gazeY = 0
  },
})
