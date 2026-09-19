import { bar, effectTemplate, envelope } from 'capsule-face-animations/effect-utils'
import { applyNeutralPose } from 'capsule-face-animations/shared'

const DURATION_MS = 8000
const VISUAL_FRAME_MS = 100

export const WaitingInputEffect = effectTemplate('waitingInput', DURATION_MS, () => {
  // A 36 x 64 pixel-art question mark, matching at least one 28 x 64 capsule eye.
  const question = new Container(null, {
    left: 142,
    top: 76,
    width: 36,
    height: 72,
    contents: [
      bar(6, 0, 24, 8),
      bar(0, 8, 8, 16),
      bar(28, 8, 8, 20),
      bar(20, 28, 16, 8),
      bar(12, 36, 8, 16),
      bar(12, 56, 8, 8),
    ],
  })
  const approve = new Label(null, {
    left: 94,
    top: 181,
    width: 132,
    height: 38,
    string: 'Approve ?',
    active: false,
    skin: new Skin({ fill: '#ffffff' }),
    style: new Style({ font: 'OpenSans-Regular-24', color: '#000000', horizontal: 'center', vertical: 'middle' }),
  })
  let lastFrame = -1
  let questionTop = 76
  let approveTop = 181
  return {
    contents: [question, approve],
    update(elapsed, strength) {
      const visible = strength > 0.8
      if (question.visible !== visible) question.visible = visible
      if (approve.visible !== visible) approve.visible = visible

      const frame = Math.floor(elapsed / VISUAL_FRAME_MS)
      if (frame === lastFrame) return
      lastFrame = frame

      const nextQuestionTop = 76 + Math.round(3 * Math.sin(elapsed / 500))
      if (nextQuestionTop !== questionTop) {
        questionTop = nextQuestionTop
        question.coordinates = { left: 142, top: questionTop, width: 36, height: 72 }
      }
      const nextApproveTop = Math.round(240 - 59 * strength)
      if (nextApproveTop !== approveTop) {
        approveTop = nextApproveTop
        approve.coordinates = { left: 94, top: approveTop, width: 132, height: 38 }
      }
    },
  }
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    const strength = envelope(elapsed, DURATION_MS)
    applyNeutralPose(face, 1 - strength)
    // The current renderer leaves a 5px slit at open=0. Slide both eyes beyond
    // their clipped canvases so they truly disappear, then return them to idle.
    face.eyes.left.gazeY = face.eyes.right.gazeY = 60 * strength
  },
})
