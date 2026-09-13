import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareCoreS3IdfDependencies, prepareWindowsNinjaResponseFiles } from './idf-dependencies.mjs'

const audioManifest = JSON.parse(readFileSync(new URL('../../host/modules/audio/manifest.json', import.meta.url)))
const audioCodec = audioManifest.platforms['esp32/m5stackchan_cores3'].dependency.find(
  ({ name }) => name === 'esp_audio_codec',
)
const wakeDependencies = audioManifest.platforms['esp32/m5stackchan_cores3'].dependency
  .filter(({ name }) => ['esp-tflite-micro', 'esp-nn', 'esp-micro-speech-features'].includes(name))
  .map(({ namespace = 'espressif', name, version }) => [`${namespace}/${name}`, version])

test('prepares CoreS3 managed components without duplicating them', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))

  try {
    const manifestPath = prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stackchan_cores3',
      applicationName: 'stack-chan-host',
      mode: 'debug',
    })
    const first = readFileSync(manifestPath, 'utf8')
    prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stackchan_cores3',
      applicationName: 'stack-chan-host',
      mode: 'debug',
    })
    const second = readFileSync(manifestPath, 'utf8')

    assert.equal(second, first)
    assert.equal(count(second, 'espressif/esp_audio_codec:'), 1)
    assert.ok(second.includes(`espressif/esp_audio_codec: ${audioCodec.version}`))
    assert.equal(count(second, 'espressif/esp32-camera:'), 1)
    for (const [name, version] of wakeDependencies) {
      assert.equal(count(second, `${name}:`), 1)
      assert.ok(second.includes(`${name}: ${version}`))
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('prepares the built-in CoreS3 camera dependency', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))

  try {
    const manifestPath = prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stack_cores3',
      applicationName: 'stack-chan-host',
      mode: 'release',
    })
    const manifest = readFileSync(manifestPath, 'utf8')

    assert.equal(count(manifest, 'espressif/esp32-camera:'), 1)
    assert.equal(count(manifest, 'espressif/esp_audio_codec:'), 0)
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('updates a stale managed component version in place', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))
  const mainDirectory = path.join(
    outputDirectory,
    'tmp/esp32/m5stackchan_cores3/release/stack-chan-host/xsProj-esp32s3/main',
  )

  try {
    mkdirSync(mainDirectory, { recursive: true })
    writeFileSync(
      path.join(mainDirectory, 'idf_component.yml'),
      "dependencies:\n  idf:\n    version: '>=4.1.0'\n  espressif/esp_audio_codec: ~2.3.0\n",
    )

    const manifestPath = prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stackchan_cores3',
      applicationName: 'stack-chan-host',
      mode: 'release',
    })
    const manifest = readFileSync(manifestPath, 'utf8')

    assert.equal(count(manifest, 'espressif/esp_audio_codec:'), 1)
    assert.ok(manifest.includes(`espressif/esp_audio_codec: ${audioCodec.version}`))
    assert.ok(!manifest.includes('espressif/esp_audio_codec: ~2.3.0'))
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('uses the generated directory for each ESP32 build mode', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))

  try {
    for (const mode of ['debug', 'instrument', 'release']) {
      const manifestPath = prepareCoreS3IdfDependencies({
        outputDirectory,
        platformName: 'm5stackchan_cores3',
        applicationName: 'stack-chan-host',
        mode,
      })
      assert.equal(
        manifestPath,
        path.join(
          outputDirectory,
          'tmp',
          'esp32',
          'm5stackchan_cores3',
          mode,
          'stack-chan-host',
          'xsProj-esp32s3',
          'main',
          'idf_component.yml',
        ),
      )
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('enables Ninja response files in the generated Windows CMake component', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))
  const moddableDirectory = path.join(fixture, 'moddable')
  const templateDirectory = path.join(moddableDirectory, 'build/devices/esp32/xsProj-esp32s3')

  try {
    mkdirSync(path.join(templateDirectory, 'main'), { recursive: true })
    writeFileSync(path.join(templateDirectory, 'CMakeLists.txt'), 'before\nproject(xs_esp32)\n')
    writeFileSync(
      path.join(templateDirectory, 'main/CMakeLists.txt'),
      'before\nidf_component_register(\n  SRCS "main.c"\n)\n',
    )

    const destinationPaths = prepareWindowsNinjaResponseFiles({
      outputDirectory: fixture,
      platformName: 'm5stackchan_cores3',
      applicationName: 'stack-chan-host',
      mode: 'release',
      moddableDirectory,
    })
    const generated = destinationPaths.map((destinationPath) => readFileSync(destinationPath, 'utf8'))

    assert.equal(generated.length, 2)
    assert.ok(generated.every((source) => /set\(CMAKE_NINJA_FORCE_RESPONSE_FILE ON\)/.test(source)))
    assert.equal(count(generated[1], 'idf_component_register('), 1)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

/**
 * Counts non-overlapping occurrences in a string.
 * @param {string} source - Text to search.
 * @param {string} value - Value to count.
 * @returns {number} Number of occurrences.
 */
function count(source, value) {
  return source.split(value).length - 1
}
