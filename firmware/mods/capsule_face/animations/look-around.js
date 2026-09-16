import { smoothStep } from 'capsule-face-animations/shared'
import { Emotion } from 'face-state'

const DURATION_MS = 7600
const LOOK_X_OFFSET_PX = 27
const KEYFRAMES = [
  [0, 0, 0, 0],
  [600, -LOOK_X_OFFSET_PX, 5, 0],
  [1400, -LOOK_X_OFFSET_PX, 5, 0],
  [2300, LOOK_X_OFFSET_PX, 0, 5],
  [3100, LOOK_X_OFFSET_PX, 0, 5],
  [4000, 22, -14, -14],
  [4800, 22, -14, -14],
  [5800, -22, 14, 14],
  [6600, -22, 14, 14],
  [DURATION_MS, 0, 0, 0],
]

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    let x = 0
    let leftY = 0
    let rightY = 0
    let previous = KEYFRAMES[0]
    for (let index = 1; index < KEYFRAMES.length; index += 1) {
      const next = KEYFRAMES[index]
      if (elapsed < next[0]) {
        const progress = smoothStep((elapsed - previous[0]) / (next[0] - previous[0]))
        x = previous[1] + (next[1] - previous[1]) * progress
        leftY = previous[2] + (next[2] - previous[2]) * progress
        rightY = previous[3] + (next[3] - previous[3]) * progress
        break
      }
      previous = next
    }

    face.emotion = Emotion.NEUTRAL
    face.eyes.left.open = 1
    face.eyes.right.open = 1
    face.eyes.left.gazeX = x / 2
    face.eyes.right.gazeX = x / 2
    face.eyes.left.gazeY = leftY / 2
    face.eyes.right.gazeY = rightY / 2
  },
})
