import { Emotion } from 'face-state'

export const smoothStep = (value) => value * value * (3 - 2 * value)

export function applyNeutralPose(face, eyeOpen = 1) {
  face.emotion = Emotion.NEUTRAL
  face.eyes.left.open = eyeOpen
  face.eyes.right.open = eyeOpen
  face.eyes.left.gazeX = 0
  face.eyes.right.gazeX = 0
  face.eyes.left.gazeY = 0
  face.eyes.right.gazeY = 0
}
