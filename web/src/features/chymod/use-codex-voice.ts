import { useCallback, useEffect, useRef, useState } from 'react'

import { errorMessage, flushVoiceLog, logVoice } from './voice-log'
import {
  type RecordingStats,
  USBVoiceClient,
  type VoiceApplicationEvent,
  type VoiceTransportState,
} from './usb-voice-client'

export type CodexVoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

type ApiError = { error?: unknown }

export function useCodexVoice(onConnectionChanged?: (connected: boolean) => void) {
  const clientRef = useRef<USBVoiceClient | undefined>(undefined)
  const activeRef = useRef(false)
  const conversationSequenceRef = useRef(0)
  const featureEnabledRef = useRef(true)
  const commandsEnabledRef = useRef(true)
  const recordingUrlRef = useRef<string | null>(null)
  const [connection, setConnection] = useState<VoiceTransportState>('disconnected')
  const [controlCapabilities, setControlCapabilities] = useState<Set<string>>(() => new Set())
  const [phase, setPhase] = useState<CodexVoicePhase>('idle')
  const [featureEnabled, setFeatureEnabledState] = useState(true)
  const [commandsEnabled, setCommandsEnabledState] = useState(true)
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [recordingStats, setRecordingStats] = useState<RecordingStats | null>(null)
  const [transcript, setTranscript] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)

  const replaceRecording = useCallback((audio?: Blob) => {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current)
    const nextUrl = audio ? URL.createObjectURL(audio) : null
    recordingUrlRef.current = nextUrl
    setRecordingUrl(nextUrl)
  }, [])

  const sendConversationState = useCallback(
    async (requestId: string, state: string, success = true, reason?: string) => {
      logVoice(success ? 'info' : 'warn', 'conversation.state', { requestId, state, success, reason })
      await clientRef.current?.sendApplicationEvent({
        schema: 'stackchan.event.v1',
        type: 'conversation.result',
        requestId,
        success,
        state,
        ...(reason ? { error: reason } : {}),
      })
    },
    []
  )

  const runConversation = useCallback(
    async (requestId: string) => {
      const client = clientRef.current
      if (!client) return
      if (!featureEnabledRef.current) {
        await sendConversationState(requestId, 'blocked', false, 'Voice feature is disabled in the local backend.')
        return
      }
      if (activeRef.current) return
      activeRef.current = true
      const startedAt = performance.now()
      const since = () => Math.round(performance.now() - startedAt)
      const sequence = ++conversationSequenceRef.current
      logVoice('info', 'conversation.start', { requestId, commands: commandsEnabledRef.current })
      const isCurrent = () => conversationSequenceRef.current === sequence
      // Once the device is told the conversation ended, failures stay on this page.
      let conversationEnded = false
      setError(null)
      setTranscript('')
      setAnswer('')
      try {
        setPhase('listening')
        await sendConversationState(requestId, 'listening')
        const audio = await client.recordUtterance()
        logVoice('info', 'conversation.recorded', { requestId, at: since(), audioBytes: audio.size })
        replaceRecording(audio)
        if (!featureEnabledRef.current) {
          await sendConversationState(requestId, 'blocked', false, 'Voice feature is disabled in the local backend.')
          setPhase('idle')
          return
        }

        // Without Codex nothing plays back, so the wake word can listen again as
        // soon as recording ends instead of after Whisper finishes.
        const transcriptionOnly = !commandsEnabledRef.current
        setPhase('transcribing')
        if (transcriptionOnly) {
          await sendConversationState(requestId, 'standby')
          conversationEnded = true
          activeRef.current = false
        } else {
          await sendConversationState(requestId, 'recognizing')
        }
        const transcribeResponse = await fetch('/api/chymod/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: audio,
        })
        const transcribeResult = (await transcribeResponse.json()) as { text?: unknown } & ApiError
        if (!transcribeResponse.ok) throw new Error(apiMessage(transcribeResult, 'Whisper transcription failed.'))
        if (typeof transcribeResult.text !== 'string' || !transcribeResult.text.trim())
          throw new Error('No speech was recognized.')
        const text = transcribeResult.text.trim()
        logVoice('info', 'conversation.transcript', { requestId, at: since(), text })
        if (!isCurrent()) return
        setTranscript(text)
        if (transcriptionOnly) {
          setPhase('idle')
          return
        }

        if (!featureEnabledRef.current) {
          await sendConversationState(requestId, 'blocked', false, 'Voice feature is disabled in the local backend.')
          setPhase('idle')
          return
        }
        if (!commandsEnabledRef.current) {
          setPhase('idle')
          await sendConversationState(requestId, 'standby')
          return
        }

        setPhase('thinking')
        const askResponse = await fetch('/api/chymod/voice/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        const askResult = (await askResponse.json()) as { answer?: unknown } & ApiError
        if (!askResponse.ok) throw new Error(apiMessage(askResult, 'Codex request failed.'))
        if (typeof askResult.answer !== 'string' || !askResult.answer.trim())
          throw new Error('Codex returned an empty answer.')
        const nextAnswer = askResult.answer.trim()
        logVoice('info', 'conversation.answer', { requestId, at: since(), answer: nextAnswer })
        setAnswer(nextAnswer)

        setPhase('speaking')
        await sendConversationState(requestId, 'speaking')
        const speechResponse = await fetch('/api/chymod/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: nextAnswer }),
        })
        if (!speechResponse.ok) {
          let result: ApiError = {}
          try {
            result = (await speechResponse.json()) as ApiError
          } catch {}
          throw new Error(apiMessage(result, 'Windows TTS failed.'))
        }
        // No caption: drawing the on-device speech balloon competes with audio playback.
        await client.playWav(await speechResponse.arrayBuffer(), '')
        logVoice('info', 'conversation.done', { requestId, at: since() })
        setPhase('idle')
        await sendConversationState(requestId, 'standby')
      } catch (cause) {
        const message = errorMessage(cause)
        logVoice('error', 'conversation.failed', {
          requestId,
          at: since(),
          message,
          stack: cause instanceof Error ? cause.stack : undefined,
        })
        if (isCurrent()) {
          setError(message)
          setPhase('error')
        }
        if (!conversationEnded) {
          await sendConversationState(requestId, 'blocked', false, message).catch(() => undefined)
        }
      } finally {
        if (isCurrent()) activeRef.current = false
        void flushVoiceLog()
      }
    },
    [replaceRecording, sendConversationState]
  )

  const handleApplicationEvent = useCallback(
    (event: VoiceApplicationEvent) => {
      if (
        event.schema !== 'stackchan.event.v1' ||
        event.type !== 'conversation.start' ||
        typeof event.requestId !== 'string'
      )
        return
      void runConversation(event.requestId)
    },
    [runConversation]
  )

  const connect = useCallback(async () => {
    try {
      setError(null)
      const status = await fetch('/api/chymod/voice/status')
      if (!status.ok) throw new Error('The local ChyMOD voice backend is unavailable.')
      const client = new USBVoiceClient()
      client.onStateChanged = (next) => {
        setConnection(next)
        onConnectionChanged?.(next === 'ready')
      }
      client.onApplicationEvent = handleApplicationEvent
      client.onControlReady = (capabilities) => setControlCapabilities(new Set(capabilities))
      client.onRecordingStats = setRecordingStats
      clientRef.current = client
      await client.connect()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setPhase('error')
    }
  }, [handleApplicationEvent, onConnectionChanged])

  const disconnect = useCallback(async () => {
    clientRef.current?.stopRecording()
    const client = clientRef.current
    clientRef.current = undefined
    await client?.disconnect()
    activeRef.current = false
    setConnection('disconnected')
    setControlCapabilities(new Set())
    setPhase('idle')
    onConnectionChanged?.(false)
  }, [onConnectionChanged])

  const stopRecording = useCallback(() => clientRef.current?.stopRecording(), [])
  const requestControl = useCallback(async (command: string, value?: unknown) => {
    const client = clientRef.current
    if (!client) throw new Error('USB voice is not connected.')
    return client.requestControl(command, value)
  }, [])
  const setFeatureEnabled = useCallback((enabled: boolean) => {
    featureEnabledRef.current = enabled
    setFeatureEnabledState(enabled)
    if (!enabled) clientRef.current?.stopRecording()
  }, [])
  const setCommandsEnabled = useCallback((enabled: boolean) => {
    commandsEnabledRef.current = enabled
    setCommandsEnabledState(enabled)
  }, [])
  const clear = useCallback(() => {
    replaceRecording()
    setTranscript('')
    setAnswer('')
    setError(null)
    setPhase('idle')
  }, [replaceRecording])

  useEffect(
    () => () => {
      void clientRef.current?.disconnect()
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current)
    },
    []
  )

  return {
    connection,
    phase,
    controlCapabilities,
    featureEnabled,
    commandsEnabled,
    recordingUrl,
    recordingStats,
    transcript,
    answer,
    error,
    connect,
    disconnect,
    stopRecording,
    requestControl,
    setFeatureEnabled,
    setCommandsEnabled,
    clear,
  }
}

function apiMessage(value: ApiError, fallback: string): string {
  return typeof value.error === 'string' && value.error ? value.error : fallback
}
