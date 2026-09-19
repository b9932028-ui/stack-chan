import { bar, effectTemplate, envelope } from 'capsule-face-animations/effect-utils'
import { applyNeutralPose } from 'capsule-face-animations/shared'

const DURATION_MS = 8000
const DOT_STEP_MS = 650

export const ThinkingEffect = effectTemplate('thinking', DURATION_MS, () => {
  // Chunky, pixel-art thought bubble in the upper-left corner.
  const dots = [bar(18, 20, 7, 7, '#000000'), bar(33, 20, 7, 7, '#000000'), bar(48, 20, 7, 7, '#000000')]
  const bubble = new Container(null, {
    left: 18,
    top: 14,
    width: 80,
    height: 68,
    visible: false,
    contents: [bar(8, 0, 56, 8), bar(0, 8, 72, 32), bar(8, 40, 56, 8), bar(56, 44, 12, 12), bar(68, 56, 8, 8), ...dots],
  })
  let lastPhase = -1

  return {
    contents: [bubble],
    update(elapsed, strength) {
      const visible = strength > 0.2
      if (bubble.visible !== visible) bubble.visible = visible
      if (!visible) return

      const phase = Math.floor(elapsed / DOT_STEP_MS) % 4
      if (phase === lastPhase) return
      lastPhase = phase
      for (let i = 0; i < dots.length; i += 1) {
        const dotVisible = i < phase
        if (dots[i].visible !== dotVisible) dots[i].visible = dotVisible
      }
    },
  }
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    const strength = envelope(elapsed, DURATION_MS)
    applyNeutralPose(face)
    face.eyes.left.gazeX = face.eyes.right.gazeX = -4 * strength
    face.eyes.left.gazeY = face.eyes.right.gazeY = -4 * strength
  },
})
