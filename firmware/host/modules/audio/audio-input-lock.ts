/**
 * Single-owner guard for the physical microphone.
 *
 * CoreS3 has one I2S input controller. Opening a second AudioIn while it is in
 * use asserts inside ESP-IDF, so all long- and short-lived consumers must claim
 * it before constructing AudioIn.
 *
 * The value is kept on globalThis because this module is preloaded into ROM and
 * a mutable module-scope binding cannot be changed there at runtime.
 */

const OWNER_KEY = 'stackchanAudioInputOwner'

type AudioInputGlobal = typeof globalThis & { [OWNER_KEY]?: string | null }

const store = globalThis as AudioInputGlobal

export function acquireAudioInput(name: string): void {
  const current = store[OWNER_KEY] ?? null
  if (current !== null) throw new Error(`microphone is in use by ${current}`)
  store[OWNER_KEY] = name
}

export function releaseAudioInput(name: string): void {
  if ((store[OWNER_KEY] ?? null) === name) store[OWNER_KEY] = null
}

export function audioInputOwner(): string | null {
  return store[OWNER_KEY] ?? null
}
