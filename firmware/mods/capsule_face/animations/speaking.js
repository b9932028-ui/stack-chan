import { bar, effectTemplate, envelope } from 'capsule-face-animations/effect-utils'
import { applyNeutralPose } from 'capsule-face-animations/shared'

const DURATION_MS = 6000
const VISUAL_FRAME_MS = 67

function pulse(elapsed) {
  return (1 + Math.sin(elapsed / 95) * Math.sin(elapsed / 230)) / 2
}

export const SpeakingEffect = effectTemplate('speaking', DURATION_MS, () => {
  // Side-mounted sound bars keep the mouthless silhouette intact.
  const bars = [
    bar(51, 110, 4, 20),
    bar(39, 114, 4, 12),
    bar(27, 117, 4, 6),
    bar(265, 110, 4, 20),
    bar(277, 114, 4, 12),
    bar(289, 117, 4, 6),
  ]
  const barTops = [110, 114, 117, 110, 114, 117]
  const barHeights = [20, 12, 6, 20, 12, 6]
  let lastFrame = -1
  return {
    contents: bars,
    update(elapsed, strength) {
      const frame = Math.floor(elapsed / VISUAL_FRAME_MS)
      if (frame === lastFrame) return
      lastFrame = frame

      for (let i = 0; i < bars.length; i += 1) {
        const height = Math.round((8 + 30 * pulse(elapsed - (i % 3) * 90)) * strength)
        const visible = height > 0
        if (bars[i].visible !== visible) bars[i].visible = visible
        const nextHeight = Math.max(1, height)
        const nextTop = Math.round(120 - nextHeight / 2)
        if (nextTop === barTops[i] && nextHeight === barHeights[i]) continue
        barTops[i] = nextTop
        barHeights[i] = nextHeight
        bars[i].coordinates = {
          left: i < 3 ? 51 - i * 12 : 265 + (i - 3) * 12,
          top: nextTop,
          width: 4,
          height: nextHeight,
        }
      }
    },
  }
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    const strength = envelope(elapsed, DURATION_MS)
    const beat = pulse(elapsed)
    applyNeutralPose(face, 1 - 0.18 * beat * strength)
    face.eyes.left.gazeY = face.eyes.right.gazeY = -2 * beat * strength
  },
})
