import angry from 'capsule-face-animations/angry'
import blink from 'capsule-face-animations/blink'
import happy from 'capsule-face-animations/happy'
import idle from 'capsule-face-animations/idle'
import listening, { ListeningEffect } from 'capsule-face-animations/listening'
import lookAround from 'capsule-face-animations/look-around'
import microsoft, { MicrosoftEffect } from 'capsule-face-animations/microsoft'
import rainbow, { RainbowEffect } from 'capsule-face-animations/rainbow'
import speaking, { SpeakingEffect } from 'capsule-face-animations/speaking'
import teams, { TEAMS_PRESENCES, TeamsEffect } from 'capsule-face-animations/teams'
import thinking, { ThinkingEffect } from 'capsule-face-animations/thinking'
import waitingInput, { WaitingInputEffect } from 'capsule-face-animations/waiting-input'
import working, { WorkingEffect } from 'capsule-face-animations/working'

export const ANIMATIONS = Object.freeze({
  idle,
  blink,
  lookAround,
  happy,
  angry,
  working,
  teams,
  listening,
  speaking,
  thinking,
  waitingInput,
  microsoft,
  rainbow,
})
export const ANIMATION_NAMES = Object.freeze(Object.keys(ANIMATIONS))
export const PLAY_ANIMATION_NAMES = Object.freeze(ANIMATION_NAMES.filter((name) => name !== 'teams'))
// Application icons and conversation indicators are manual actions.
export const RANDOM_ANIMATION_NAMES = Object.freeze(['idle', 'blink', 'lookAround', 'happy', 'angry', 'working'])
export {
  ListeningEffect,
  MicrosoftEffect,
  RainbowEffect,
  SpeakingEffect,
  TEAMS_PRESENCES,
  TeamsEffect,
  ThinkingEffect,
  WaitingInputEffect,
  WorkingEffect,
}
