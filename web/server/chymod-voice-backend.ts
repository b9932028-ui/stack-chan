import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

import {
  logVoiceEvent,
  logVoiceEvents,
  readVoiceLogBatch,
  VOICE_LOG_PATH,
  type VoiceLogLevel,
} from './chymod-voice-log'
import { applyRobotVoice, ROBOT_VOICE_PRESETS, type RobotVoicePreset } from './robot-voice'

const MAX_AUDIO_BYTES = 16 * 1024 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const MAX_LOG_BYTES = 1024 * 1024
const CODEX_MODEL = 'gpt-5.6-luna'
const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url))
const WHISPER_WORKER_SCRIPT = join(SERVER_DIR, 'chymod-whisper-worker.py')
const WHISPER_REQUEST_TIMEOUT_MILLISECONDS = 180_000
const TTS_SCRIPT = join(SERVER_DIR, 'chymod-tts.ps1')
// Windows SAPI voice plus robot post-processing (robot-voice.ts). SAPI.SpVoice
// sees only the Desktop voices: "Zira" or "David".
// The processed "stackchan" preset was hard to understand through the robot's small
// speaker, so replies use plain David, compressed to sound louder ("loud").
const TTS_VOICE = 'David'
const TTS_PITCH = 0
const TTS_RATE = 0
const TTS_ROBOT_PRESET: RobotVoicePreset = 'loud'
const DEFAULT_WHISPER_PYTHON = process.env.USERPROFILE
  ? join(process.env.USERPROFILE, 'anaconda3', 'envs', 'Whisper', 'python.exe')
  : ''

type JsonRecord = Record<string, unknown>

export function chymodVoiceBackend(): Plugin {
  return {
    name: 'chymod-voice-backend',
    configureServer(server) {
      logVoiceEvent({ level: 'info', event: 'backend.started', logPath: VOICE_LOG_PATH })
      server.httpServer?.once('close', () => {
        logVoiceEvent({ level: 'info', event: 'backend.stopped' })
        whisperWorker.close()
      })
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?', 1)[0]
        if (!path?.startsWith('/api/chymod/voice/')) {
          next()
          return
        }
        try {
          if (request.method === 'GET' && path === '/api/chymod/voice/status') {
            // Connecting the page warms the Whisper model before the first utterance.
            void whisperWorker.start().catch(() => undefined)
            sendJson(response, 200, {
              ready: true,
              logPath: VOICE_LOG_PATH,
              model: CODEX_MODEL,
              whisperModel: 'small',
              whisperDevice: whisperWorker.info?.device ?? 'loading',
              whisperComputeType: whisperWorker.info?.computeType ?? 'loading',
              persistence: 'request-temporary-files-only',
            })
            return
          }
          if (request.method === 'POST' && path === '/api/chymod/voice/log') {
            const entries = readVoiceLogBatch(await readJson(request, MAX_LOG_BYTES))
            await logVoiceEvents(entries, 'page')
            sendJson(response, 200, { accepted: entries.length })
            return
          }
          if (request.method === 'POST' && path === '/api/chymod/voice/transcribe') {
            const audio = await readBody(request, MAX_AUDIO_BYTES)
            if (audio.byteLength < 44) throw new HttpError(400, 'Recorded audio is empty.')
            const startedAt = Date.now()
            const text = await transcribe(audio)
            logVoiceEvent({
              level: 'info',
              event: 'backend.transcribe',
              milliseconds: Date.now() - startedAt,
              audioBytes: audio.byteLength,
              device: whisperWorker.info?.device ?? 'unknown',
              text,
            })
            sendJson(response, 200, { text })
            return
          }
          if (request.method === 'POST' && path === '/api/chymod/voice/ask') {
            const body = await readJson(request)
            const text = requiredText(body.text, 'Transcript')
            const startedAt = Date.now()
            const answer = await askCodex(text)
            logVoiceEvent({
              level: 'info',
              event: 'backend.ask',
              milliseconds: Date.now() - startedAt,
              model: CODEX_MODEL,
              question: text,
              answer,
            })
            sendJson(response, 200, { answer, model: CODEX_MODEL })
            return
          }
          if (request.method === 'POST' && path === '/api/chymod/voice/speak') {
            const body = await readJson(request)
            const text = requiredText(body.text, 'Answer')
            const startedAt = Date.now()
            const audio = await synthesize(text)
            logVoiceEvent({
              level: 'info',
              event: 'backend.speak',
              milliseconds: Date.now() - startedAt,
              audioBytes: audio.byteLength,
              voice: TTS_VOICE,
              preset: TTS_ROBOT_PRESET,
              text,
            })
            response.statusCode = 200
            response.setHeader('Content-Type', 'audio/wav')
            response.setHeader('Cache-Control', 'no-store')
            response.end(audio)
            return
          }
          throw new HttpError(404, 'Unknown ChyMOD voice endpoint.')
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof Error ? error.message : String(error)
          const level: VoiceLogLevel = status >= 500 ? 'error' : 'warn'
          logVoiceEvent({
            level,
            event: 'backend.request-failed',
            path,
            status,
            message,
            stack: error instanceof Error ? error.stack : undefined,
          })
          sendJson(response, status, { error: message })
        }
      })
    },
  }
}

async function transcribe(audio: Buffer): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'chymod-whisper-'))
  const audioPath = join(workspace, 'utterance.wav')
  try {
    await writeFile(audioPath, audio)
    return requiredText(await whisperWorker.transcribe(audioPath), 'Whisper transcript')
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

type WhisperDevice = { device: string; computeType: string }

type PendingTranscription = {
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Keeps faster-whisper loaded between utterances instead of starting Python and
 * loading the model for every request (chymod-whisper-worker.py).
 */
class WhisperWorker {
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<WhisperDevice>
  private device?: WhisperDevice
  private nextId = 1
  private readonly pending = new Map<number, PendingTranscription>()
  private stderrTail = ''

  get info(): WhisperDevice | undefined {
    return this.device
  }

  start(): Promise<WhisperDevice> {
    if (this.ready) return this.ready
    const python =
      process.env.CHYMOD_WHISPER_PYTHON ||
      (DEFAULT_WHISPER_PYTHON && existsSync(DEFAULT_WHISPER_PYTHON) ? DEFAULT_WHISPER_PYTHON : 'python')
    const child = spawn(python, ['-u', WHISPER_WORKER_SCRIPT, '--model', 'small'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.stderrTail = ''
    this.ready = new Promise<WhisperDevice>((resolve, reject) => {
      let buffered = ''
      const fail = (error: Error) => {
        if (this.child !== child) return
        this.reset(error)
        reject(error)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf('\n')
          if (line) this.handleLine(line, resolve)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-8000)
      })
      child.on('error', fail)
      child.on('close', (code) =>
        fail(new Error(summarizeProcessFailure(this.stderrTail, `Whisper worker exited with code ${code}.`)))
      )
    })
    return this.ready
  }

  async transcribe(audioPath: string): Promise<string> {
    await this.start()
    const child = this.child
    if (!child) throw new Error('Whisper worker is not running.')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Whisper transcription timed out.'))
        this.close()
      }, WHISPER_REQUEST_TIMEOUT_MILLISECONDS)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, audio: audioPath })}\n`)
    })
  }

  close(): void {
    const child = this.child
    this.reset(new Error('Whisper worker stopped.'))
    child?.kill()
  }

  private handleLine(line: string, resolveReady: (device: WhisperDevice) => void): void {
    let message: {
      type?: unknown
      id?: unknown
      text?: unknown
      error?: unknown
      device?: unknown
      computeType?: unknown
    }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (message.type === 'ready') {
      this.device = { device: String(message.device), computeType: String(message.computeType) }
      logVoiceEvent({ level: 'info', event: 'whisper.ready', ...this.device })
      resolveReady(this.device)
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    clearTimeout(request.timer)
    if (typeof message.text === 'string') request.resolve(message.text)
    else request.reject(new Error(typeof message.error === 'string' ? message.error : 'Whisper transcription failed.'))
  }

  private reset(error: Error): void {
    if (this.child) logVoiceEvent({ level: 'warn', event: 'whisper.stopped', message: error.message })
    this.child = undefined
    this.ready = undefined
    this.device = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

const whisperWorker = new WhisperWorker()

async function askCodex(transcript: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'chymod-codex-'))
  const prompt = [
    'You are Copilot, the voice assistant.',
    'Reply in US English unless the user clearly requests another language.',
    'Answer in exactly one short sentence that captures only the most essential point.',
    'This reply is spoken aloud, so use plain words with no Markdown, lists, or URLs.',
    'You may inspect read-only information if useful, but never modify files or perform external actions.',
    '',
    `User said: ${transcript}`,
  ].join('\n')
  try {
    const codex = resolveCodexCommand()
    const result = await runProcess(
      codex.executable,
      [
        ...codex.prefixArgs,
        'exec',
        // Voice replies skip the user's hooks and config; luna's fastest effort is low.
        '--ignore-user-config',
        '-c',
        'model_reasoning_effort="low"',
        '--model',
        CODEX_MODEL,
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '-C',
        workspace,
        '-',
      ],
      prompt,
      180_000
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(
          'Codex CLI was not found. Install it with `npm install -g @openai/codex`, or set CHYMOD_CODEX_BIN to its path.'
        )
      }
      throw error
    })
    return requiredText(result.stdout, 'Codex answer')
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

type CodexCommand = { executable: string; prefixArgs: string[] }

/**
 * An npm global install puts `codex.cmd` on PATH on Windows, which spawn() cannot
 * run without a shell. Run the package's JavaScript entry with this Node instead,
 * so arguments still bypass the shell.
 */
function resolveCodexCommand(): CodexCommand {
  const configured = process.env.CHYMOD_CODEX_BIN
  if (configured) {
    return configured.toLowerCase().endsWith('.js')
      ? { executable: process.execPath, prefixArgs: [configured] }
      : { executable: configured, prefixArgs: [] }
  }
  if (process.platform !== 'win32') return { executable: 'codex', prefixArgs: [] }

  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.env.APPDATA) directories.push(join(process.env.APPDATA, 'npm'))
  for (const directory of directories) {
    const executable = join(directory, 'codex.exe')
    if (existsSync(executable)) return { executable, prefixArgs: [] }
    const entry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(join(directory, 'codex.cmd')) && existsSync(entry)) {
      return { executable: process.execPath, prefixArgs: [entry] }
    }
  }
  return { executable: 'codex', prefixArgs: [] }
}

async function synthesize(text: string): Promise<Buffer> {
  const workspace = await mkdtemp(join(tmpdir(), 'chymod-tts-'))
  const outputPath = join(workspace, 'reply.wav')
  try {
    await runProcess(
      process.env.CHYMOD_POWERSHELL_BIN || 'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        TTS_SCRIPT,
        '-OutputPath',
        outputPath,
        '-Voice',
        TTS_VOICE,
        '-Pitch',
        String(TTS_PITCH),
        '-Rate',
        String(TTS_RATE),
      ],
      text,
      60_000
    )
    const speech = applyRobotVoice(new Uint8Array(await readFile(outputPath)), ROBOT_VOICE_PRESETS[TTS_ROBOT_PRESET])
    return Buffer.from(speech.buffer, speech.byteOffset, speech.byteLength)
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

async function readJson(request: IncomingMessage, limit = MAX_TEXT_BYTES): Promise<JsonRecord> {
  const body = await readBody(request, limit)
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Request body must be an object.')
  return value as JsonRecord
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) throw new HttpError(413, 'Request body is too large.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is empty.`)
  return value.trim()
}

function sendJson(response: ServerResponse, status: number, value: JsonRecord): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

function runProcess(
  executable: string,
  args: string[],
  stdin: string | undefined,
  timeoutMilliseconds: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${executable} timed out.`))
    }, timeoutMilliseconds)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8').trim(),
          stderr: Buffer.concat(stderr).toString('utf8').trim(),
        })
    }
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code === 0) finish()
      else
        finish(
          new Error(
            summarizeProcessFailure(Buffer.concat(stderr).toString('utf8'), `${executable} exited with code ${code}.`)
          )
        )
    })
    if (stdin !== undefined) child.stdin.end(stdin, 'utf8')
    else child.stdin.end()
  })
}

const MAX_ERROR_CHARACTERS = 1000

/**
 * CLI stderr can be hundreds of kilobytes (Codex logs whole model lists), so keep
 * only the actionable part: the last `ERROR:` line's message, else the last lines.
 */
function summarizeProcessFailure(stderr: string, fallback: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^ERROR:\s*(.+)$/.exec(lines[index])
    if (!match) continue
    try {
      const parsed = JSON.parse(match[1]) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string') return truncateText(parsed.error.message)
    } catch {}
    return truncateText(match[1])
  }
  const tail = lines.slice(-3).join('\n')
  return tail ? truncateText(tail) : fallback
}

function truncateText(text: string): string {
  return text.length > MAX_ERROR_CHARACTERS ? `${text.slice(0, MAX_ERROR_CHARACTERS)}…` : text
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
