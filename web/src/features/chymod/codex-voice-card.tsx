import { Bot, Download, MicOff, RotateCcw } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

import { useCodexVoice, type CodexVoicePhase } from './use-codex-voice'

export type CodexVoiceController = ReturnType<typeof useCodexVoice>

const phaseLabels: Record<CodexVoicePhase, string> = {
  idle: 'Waiting for “Hey Copilot”',
  listening: 'Listening',
  transcribing: 'Transcribing locally',
  thinking: 'Copilot is thinking',
  speaking: 'Stack-Chan is speaking',
  error: 'Needs attention',
}

function formatMilliseconds(value: number | null): string {
  return value === null ? '—' : `${value} ms`
}

export function CodexVoiceCard({ voice }: { voice: CodexVoiceController }) {
  const connected = voice.connection === 'ready'

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-5" /> Hey Copilot
            </CardTitle>
            <CardDescription>
              Local Whisper small → Codex gpt-5.6-luna (read-only) → Windows TTS → Stack-Chan USB audio
            </CardDescription>
          </div>
          <Badge variant={connected ? 'default' : 'secondary'}>
            {connected ? phaseLabels[voice.phase] : voice.connection}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <section className="grid gap-3 rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <Checkbox
              id="chymod-voice-feature"
              checked={voice.featureEnabled}
              onCheckedChange={(checked) => voice.setFeatureEnabled(checked === true)}
            />
            <div className="grid gap-1">
              <Label htmlFor="chymod-voice-feature">Enable voice feature</Label>
              <p className="text-sm text-muted-foreground">
                Process Hey Copilot requests in this local backend. Turning it off stops any active recording.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="chymod-voice-commands"
              checked={voice.commandsEnabled}
              disabled={!voice.featureEnabled}
              onCheckedChange={(checked) => voice.setCommandsEnabled(checked === true)}
            />
            <div className="grid gap-1">
              <Label htmlFor="chymod-voice-commands">Run Codex commands</Label>
              <p className="text-sm text-muted-foreground">
                Turn this off to stop after Whisper transcription and inspect the text below. Stack-Chan listens for
                “Hey Copilot” again as soon as recording ends.
              </p>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          {voice.phase === 'listening' && (
            <Button variant="outline" onClick={voice.stopRecording}>
              <MicOff data-icon="inline-start" /> Stop recording
            </Button>
          )}
          {(voice.transcript || voice.answer || voice.error) && (
            <Button variant="ghost" disabled={voice.phase !== 'idle' && voice.phase !== 'error'} onClick={voice.clear}>
              <RotateCcw data-icon="inline-start" /> Clear
            </Button>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Use the page’s single Connect with USB button. Keep this page open, enable the local voice feature, then speak
          after the expression changes. These switches apply only while this page is open.
        </p>

        {voice.recordingUrl && (
          <section className="grid gap-3 rounded-lg border p-4">
            <div>
              <h3 className="text-sm font-medium">Last microphone recording</h3>
              <p className="text-sm text-muted-foreground">This is the exact WAV submitted to Whisper.</p>
            </div>
            <audio
              className="w-full"
              controls
              preload="metadata"
              src={voice.recordingUrl}
              aria-label="Last microphone recording"
            />
            <div>
              <Button
                variant="outline"
                render={<a href={voice.recordingUrl} download="stack-chan-last-recording.wav" />}
              >
                <Download data-icon="inline-start" /> Download WAV
              </Button>
            </div>
          </section>
        )}

        {voice.recordingStats && (
          <section className="grid gap-2 rounded-lg border p-4">
            <h3 className="text-sm font-medium">Microphone diagnostics</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {(
                [
                  ['Stop reason', voice.recordingStats.stopReason],
                  ['MIC_STOP sent', `${voice.recordingStats.stopSentMilliseconds} ms`],
                  ['Audio received', `${voice.recordingStats.audioMilliseconds} ms`],
                  ['First frame', formatMilliseconds(voice.recordingStats.firstFrameMilliseconds)],
                  ['Last frame', formatMilliseconds(voice.recordingStats.lastFrameMilliseconds)],
                  ['Frames', `${voice.recordingStats.frames} (+${voice.recordingStats.framesAfterStop} after stop)`],
                  ['Missing frames', voice.recordingStats.missingFrames],
                  ['Peak RMS', voice.recordingStats.peakRms],
                  [
                    'Parser discarded',
                    `${voice.recordingStats.parserDiscardedBytes} B / ${voice.recordingStats.parserCrcFailures} CRC`,
                  ],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {voice.transcript && (
          <section className="grid gap-1 rounded-lg border p-4">
            <h3 className="text-sm font-medium">You said</h3>
            <p className="whitespace-pre-wrap text-sm">{voice.transcript}</p>
          </section>
        )}
        {voice.answer && (
          <section className="grid gap-1 rounded-lg border p-4">
            <h3 className="text-sm font-medium">Copilot</h3>
            <p className="whitespace-pre-wrap text-sm">{voice.answer}</p>
          </section>
        )}
        {voice.error && (
          <Alert variant="destructive">
            <AlertDescription>{voice.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
