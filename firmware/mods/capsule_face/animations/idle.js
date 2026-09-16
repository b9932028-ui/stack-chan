import { applyNeutralPose } from 'capsule-face-animations/shared'

export default Object.freeze({
  duration: null,
  apply(face) {
    applyNeutralPose(face)
  },
})
