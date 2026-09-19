import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canonicalizeBrightness, DEFAULT_DISPLAY_BRIGHTNESS } from './brightness-model.js'

test('display brightness defaults to full brightness', () => {
  assert.equal(canonicalizeBrightness(undefined), DEFAULT_DISPLAY_BRIGHTNESS)
})

test('display brightness is rounded and clamped to a percentage', () => {
  assert.equal(canonicalizeBrightness(48.6), 49)
  assert.equal(canonicalizeBrightness(-1), 0)
  assert.equal(canonicalizeBrightness(101), 100)
})
