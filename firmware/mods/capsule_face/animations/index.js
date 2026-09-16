import angry from 'capsule-face-animations/angry'
import blink from 'capsule-face-animations/blink'
import happy from 'capsule-face-animations/happy'
import idle from 'capsule-face-animations/idle'
import lookAround from 'capsule-face-animations/look-around'
import working, { WorkingEffect } from 'capsule-face-animations/working'

export const ANIMATIONS = Object.freeze({ idle, blink, lookAround, happy, angry, working })
export const ANIMATION_NAMES = Object.freeze(Object.keys(ANIMATIONS))
export { WorkingEffect }
