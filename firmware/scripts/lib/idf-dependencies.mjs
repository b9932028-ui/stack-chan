import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dependenciesByPlatform = {
  m5stack_cores3: [['espressif/esp32-camera', '^2.0.10']],
  m5stackchan_cores3: [
    ['espressif/esp_audio_codec', '~2.5.0'],
    ['espressif/esp32-camera', '^2.0.10'],
    ['espressif/esp-tflite-micro', '==1.3.3~1'],
    ['espressif/esp-nn', '==1.1.2'],
    ['esphome/esp-micro-speech-features', '==1.2.3'],
  ],
}

const windowsNinjaResponseFileSetting = 'set(CMAKE_NINJA_FORCE_RESPONSE_FILE ON)'

/**
 * Seeds a generated CoreS3 IDF manifest before Moddable adds dependencies.
 * @param {{outputDirectory: string, platformName: string, applicationName: string, mode: string}} options - Build output configuration.
 * @returns {string} Path to the prepared IDF component manifest.
 */
export function prepareCoreS3IdfDependencies({ outputDirectory, platformName, applicationName, mode }) {
  if (!outputDirectory) throw new Error('Build output directory is required')
  const dependencies = dependenciesByPlatform[platformName]
  if (!dependencies) throw new Error(`Unsupported CoreS3 platform: ${platformName}`)
  if (!applicationName) throw new Error('Application name is required')
  if (!['debug', 'instrument', 'release'].includes(mode)) throw new Error(`Unsupported build mode: ${mode}`)

  const mainDirectory = path.join(
    outputDirectory,
    'tmp',
    'esp32',
    platformName,
    mode,
    applicationName,
    'xsProj-esp32s3',
    'main',
  )
  const manifestPath = path.join(mainDirectory, 'idf_component.yml')
  mkdirSync(mainDirectory, { recursive: true })

  const originalManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  let manifest =
    originalManifest ?? "## IDF Component Manager Manifest File\ndependencies:\n  idf:\n    version: '>=4.1.0'\n"

  if (!/^dependencies:\s*$/m.test(manifest)) {
    throw new Error(`IDF component manifest has no dependencies block: ${manifestPath}`)
  }

  for (const [name, version] of dependencies) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const dependencyPattern = new RegExp(`^  ${escapedName}:.*$`, 'm')
    if (dependencyPattern.test(manifest)) {
      manifest = manifest.replace(dependencyPattern, `  ${name}: ${version}`)
      continue
    }
    if (!manifest.endsWith('\n')) manifest += '\n'
    manifest += `  ${name}: ${version}\n`
  }

  // Moddable 8.3.1 joins multiple `idf.py add-dependency` commands with `&` on
  // POSIX, so clean builds can race while updating this file. Seed both entries
  // before mcconfig runs and its generated checks become no-ops.
  if (manifest !== originalManifest) writeFileSync(manifestPath, manifest)
  console.log(`[stack-chan] prepared IDF dependencies: ${manifestPath}`)
  return manifestPath
}

/**
 * Prepares Moddable's generated ESP-IDF main component to use Ninja response
 * files on Windows. ESP-SR and ESP-DSP expose enough include directories to
 * exceed CreateProcess's command-line limit before GCC can start.
 * @param {{outputDirectory: string, platformName: string, applicationName: string, mode: string, moddableDirectory?: string}} options - Build output configuration.
 * @returns {string[]|null} Generated CMake files, or null outside Windows.
 */
export function prepareWindowsNinjaResponseFiles({
  outputDirectory,
  platformName,
  applicationName,
  mode,
  moddableDirectory = process.env.MODDABLE,
}) {
  if (process.platform !== 'win32') return null
  if (!moddableDirectory) throw new Error('MODDABLE environment variable is required')
  if (platformName !== 'm5stackchan_cores3') return null

  const templateDirectory = path.join(moddableDirectory, 'build', 'devices', 'esp32', 'xsProj-esp32s3')
  const projectDirectory = path.dirname(
    generatedMainDirectory({ outputDirectory, platformName, applicationName, mode }),
  )
  const files = [
    prepareResponseFileCMake({
      templateDirectory,
      projectDirectory,
      relativePath: 'CMakeLists.txt',
      marker: 'project(',
    }),
    prepareResponseFileCMake({
      templateDirectory,
      projectDirectory,
      relativePath: path.join('main', 'CMakeLists.txt'),
      marker: 'idf_component_register(',
    }),
  ]
  console.log(`[stack-chan] enabled Windows Ninja response files: ${files.join(', ')}`)
  return files
}

function prepareResponseFileCMake({ templateDirectory, projectDirectory, relativePath, marker }) {
  const templatePath = path.join(templateDirectory, relativePath)
  const destinationPath = path.join(projectDirectory, relativePath)
  const template = readFileSync(templatePath, 'utf8')
  if (!template.includes(marker)) throw new Error(`Unexpected Moddable ESP32 CMake template: ${templatePath}`)
  const generated = template.replace(marker, `${windowsNinjaResponseFileSetting}\n\n${marker}`)

  mkdirSync(path.dirname(destinationPath), { recursive: true })
  if (!existsSync(destinationPath) || readFileSync(destinationPath, 'utf8') !== generated) {
    writeFileSync(destinationPath, generated)
  }
  return destinationPath
}

function generatedMainDirectory({ outputDirectory, platformName, applicationName, mode }) {
  return path.join(outputDirectory, 'tmp', 'esp32', platformName, mode, applicationName, 'xsProj-esp32s3', 'main')
}
