import { bar, effectTemplate, envelope } from 'capsule-face-animations/effect-utils'
import { applyNeutralPose } from 'capsule-face-animations/shared'

const DURATION_MS = 6000
const VISUAL_FRAME_MS = 67

export const ListeningEffect = effectTemplate('listening', DURATION_MS, () => {
  // Microphone capsule, cradle, stem and base, drawn without font glyphs.
  const microphone = new Container(null, {
    left: 142,
    top: 178,
    width: 36,
    height: 48,
    contents: [
      bar(12, 0, 12, 25),
      bar(5, 12, 3, 20),
      bar(28, 12, 3, 20),
      bar(5, 30, 26, 3),
      bar(17, 33, 3, 10),
      bar(9, 43, 20, 3),
    ],
  })
  const waves = [bar(119, 186, 3, 18), bar(105, 180, 3, 30), bar(198, 186, 3, 18), bar(212, 180, 3, 30)]
  let lastFrame = -1
  let microphoneTop = 178
  return {
    contents: [microphone, ...waves],
    update(elapsed, strength) {
      const frame = Math.floor(elapsed / VISUAL_FRAME_MS)
      if (frame === lastFrame) return
      lastFrame = frame

      const microphoneVisible = strength > 0.05
      if (microphone.visible !== microphoneVisible) microphone.visible = microphoneVisible
      const nextMicrophoneTop = Math.round(240 - 62 * strength)
      if (nextMicrophoneTop !== microphoneTop) {
        microphoneTop = nextMicrophoneTop
        microphone.coordinates = { left: 142, top: microphoneTop, width: 36, height: 48 }
      }
      for (let i = 0; i < waves.length; i += 1) {
        const visible = strength > 0.5 && elapsed % 1200 > (i % 2) * 300
        if (waves[i].visible !== visible) waves[i].visible = visible
      }
    },
  }
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face, elapsed) {
    const strength = envelope(elapsed, DURATION_MS)
    applyNeutralPose(face)
    const tilt = Math.sin(elapsed / 900) * strength
    face.eyes.left.gazeY = -2 * strength - tilt
    face.eyes.right.gazeY = -2 * strength + tilt
    face.eyes.left.gazeX = face.eyes.right.gazeX = 2 * tilt
  },
})
