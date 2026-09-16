param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  # Substring of an installed SAPI voice description, such as "Zira"; empty keeps the default voice.
  [string]$Voice = '',
  [ValidateRange(-10, 10)]
  [int]$Pitch = 0,
  [ValidateRange(-10, 10)]
  [int]$Rate = 0
)

[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$text = [Console]::In.ReadToEnd().Trim()
if (-not $text) {
  throw 'TTS text is empty.'
}

$speaker = New-Object -ComObject SAPI.SpVoice
$stream = New-Object -ComObject SAPI.SpFileStream
$format = New-Object -ComObject SAPI.SpAudioFormat
try {
  if ($Voice) {
    $voices = $speaker.GetVoices()
    $selected = $null
    for ($index = 0; $index -lt $voices.Count; $index++) {
      if ($voices.Item($index).GetDescription() -like "*$Voice*") {
        $selected = $voices.Item($index)
        break
      }
    }
    if (-not $selected) {
      throw "TTS voice not found: $Voice"
    }
    $speaker.Voice = $selected
  }
  $speaker.Rate = $Rate

  # SpeechAudioFormatType.SAFT24kHz16BitMono (26; 22 is 22.05 kHz), the speaker's native rate on Stack-Chan.
  $format.Type = 26
  $stream.Format = $format
  $stream.Open($OutputPath, 3, $false)
  $speaker.AudioOutputStream = $stream
  # SVSFIsXML: the escaped text is wrapped in a SAPI pitch element.
  $escaped = [System.Security.SecurityElement]::Escape($text)
  [void]$speaker.Speak("<pitch absmiddle=`"$Pitch`">$escaped</pitch>", 8)
} finally {
  try { $stream.Close() } catch {}
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($format)
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($stream)
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($speaker)
}
