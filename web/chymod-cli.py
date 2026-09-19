#!/usr/bin/env python3
"""Play a ChyMOD animation and Windows TTS over Stack-Chan's USB protocol."""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import tempfile
import time
import wave
import zlib
from pathlib import Path

import serial


MAGIC = 0x5343
VERSION = 2
HEADER_BYTES = 20
MAX_PAYLOAD = 4096

CONTROL = 0
SPEAKER_PCM = 2
EVENT = 6

HELLO = 1
HELLO_ACK = 2
ERROR = 3
SPEAKER_START = 32
SPEAKER_CREDIT = 33
SPEAKER_END = 34
SPEAKER_DONE = 35

EVENT_START_END = 3
WEB_CAPABILITIES = 0xE7F


class StackChanUSB:
    def __init__(self, port: str):
        self.serial = serial.Serial(port, 115200, timeout=0.1, write_timeout=2)
        self.buffer = bytearray()
        self.control_sequence = 0
        self.event_id = 0

    def close(self) -> None:
        self.serial.close()

    def send_frame(
        self,
        frame_type: int,
        *,
        flags: int = 0,
        stream_id: int = 0,
        sequence: int = 0,
        sample_rate: int = 0,
        payload: bytes = b'',
    ) -> None:
        if len(payload) > MAX_PAYLOAD:
            raise ValueError('USB payload is too large')
        header = struct.pack(
            '<HBBHHIII', MAGIC, VERSION, frame_type, flags, stream_id, sequence, sample_rate, len(payload)
        )
        packet = header + payload
        self.serial.write(packet + struct.pack('<I', zlib.crc32(packet) & 0xFFFFFFFF))

    def send_control(self, control: int, stream_id: int = 0, sample_rate: int = 0, payload: bytes = b'') -> None:
        self.send_frame(
            CONTROL,
            flags=control,
            stream_id=stream_id,
            sequence=self.control_sequence,
            sample_rate=sample_rate,
            payload=payload,
        )
        self.control_sequence += 1

    def send_event(self, event: dict) -> None:
        payload = json.dumps(event, separators=(',', ':')).encode('utf-8')
        if len(payload) > MAX_PAYLOAD:
            raise ValueError('CLI event is too large')
        self.event_id = 1 if self.event_id >= 0xFFFF else self.event_id + 1
        self.send_frame(EVENT, flags=EVENT_START_END, stream_id=self.event_id, payload=payload)

    def read_frame(self, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        magic = struct.pack('<H', MAGIC)
        while time.monotonic() < deadline:
            available = self.serial.in_waiting
            chunk = self.serial.read(available or 1)
            if chunk:
                self.buffer.extend(chunk)
            while len(self.buffer) >= HEADER_BYTES + 4:
                offset = self.buffer.find(magic)
                if offset < 0:
                    del self.buffer[:-1]
                    break
                if offset:
                    del self.buffer[:offset]
                if len(self.buffer) < HEADER_BYTES + 4:
                    break
                _, version, frame_type, flags, stream_id, sequence, sample_rate, size = struct.unpack(
                    '<HBBHHIII', self.buffer[:HEADER_BYTES]
                )
                if version != VERSION or size > MAX_PAYLOAD:
                    del self.buffer[0]
                    continue
                packet_size = HEADER_BYTES + size + 4
                if len(self.buffer) < packet_size:
                    break
                packet = bytes(self.buffer[: HEADER_BYTES + size])
                expected_crc = struct.unpack('<I', self.buffer[HEADER_BYTES + size : packet_size])[0]
                del self.buffer[:packet_size]
                if zlib.crc32(packet) & 0xFFFFFFFF != expected_crc:
                    continue
                return {
                    'type': frame_type,
                    'flags': flags,
                    'stream_id': stream_id,
                    'sequence': sequence,
                    'sample_rate': sample_rate,
                    'payload': packet[HEADER_BYTES:],
                }
        raise TimeoutError('Timed out waiting for Stack-Chan')

    def wait_control(self, control: int, timeout: float, stream_id: int | None = None) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self.read_frame(max(0.05, deadline - time.monotonic()))
            if frame['type'] != CONTROL:
                continue
            if frame['flags'] == ERROR:
                code = struct.unpack('<I', frame['payload'])[0] if len(frame['payload']) == 4 else 0
                raise RuntimeError(f'Stack-Chan USB error {code}')
            if frame['flags'] == control and (stream_id is None or frame['stream_id'] == stream_id):
                return frame
        raise TimeoutError(f'Timed out waiting for control {control}')

    def handshake(self) -> None:
        self.send_control(HELLO, payload=struct.pack('<II', MAX_PAYLOAD, WEB_CAPABILITIES))
        ack = self.wait_control(HELLO_ACK, 5)
        if len(ack['payload']) != 8:
            raise RuntimeError('Invalid Stack-Chan HELLO_ACK')

    def request_animation(self, name: str) -> None:
        request_id = 1
        self.send_event({'type': 'session.created', 'event_id': f'cli-{int(time.time() * 1000)}'})
        self.send_event({'type': 'control.command', 'requestId': request_id, 'command': 'chymod.play', 'value': name})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            frame = self.read_frame(max(0.05, deadline - time.monotonic()))
            if frame['type'] == CONTROL and frame['flags'] == ERROR:
                code = struct.unpack('<I', frame['payload'])[0] if len(frame['payload']) == 4 else 0
                raise RuntimeError(f'Stack-Chan USB error {code}')
            if frame['type'] != EVENT or not (frame['flags'] & 2):
                continue
            try:
                event = json.loads(frame['payload'].decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if event.get('type') != 'control.result' or event.get('requestId') != request_id:
                continue
            if event.get('ok') is not True:
                raise RuntimeError(event.get('error', 'chymod.play failed'))
            return
        raise TimeoutError('Timed out waiting for chymod.play')

    def play_pcm(self, sample_rate: int, pcm: bytes) -> None:
        stream_id = 1
        self.send_control(SPEAKER_START, stream_id, sample_rate)
        credit = 0
        offset = 0
        sequence = 0
        deadline = time.monotonic() + 60
        while offset < len(pcm):
            if credit <= 0:
                frame = self.read_frame(max(0.05, deadline - time.monotonic()))
                if frame['type'] == CONTROL and frame['flags'] == ERROR:
                    code = struct.unpack('<I', frame['payload'])[0] if len(frame['payload']) == 4 else 0
                    raise RuntimeError(f'Stack-Chan USB error {code}')
                if (
                    frame['type'] == CONTROL
                    and frame['flags'] == SPEAKER_CREDIT
                    and frame['stream_id'] == stream_id
                    and len(frame['payload']) == 4
                ):
                    credit += struct.unpack('<I', frame['payload'])[0]
                continue
            size = min(MAX_PAYLOAD, credit, len(pcm) - offset)
            self.send_frame(
                SPEAKER_PCM,
                stream_id=stream_id,
                sequence=sequence,
                sample_rate=sample_rate,
                payload=pcm[offset : offset + size],
            )
            offset += size
            credit -= size
            sequence += 1
        self.send_control(SPEAKER_END, stream_id, sample_rate)
        self.wait_control(SPEAKER_DONE, 60, stream_id)


def synthesize(text: str) -> tuple[int, bytes]:
    tts_script = Path(__file__).resolve().parent / 'server' / 'chymod-tts.ps1'
    with tempfile.TemporaryDirectory(prefix='chymod-cli-') as directory:
        wav_path = Path(directory) / 'speech.wav'
        subprocess.run(
            [
                'powershell.exe',
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                str(tts_script),
                '-OutputPath',
                str(wav_path),
            ],
            input=text,
            text=True,
            check=True,
        )
        with wave.open(str(wav_path), 'rb') as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() not in (8000, 16000, 24000):
                raise RuntimeError('TTS must return mono PCM16 at 8, 16, or 24 kHz')
            return source.getframerate(), source.readframes(source.getnframes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default='COM7')
    parser.add_argument('--animation', default='speaking')
    parser.add_argument('--text', required=True)
    args = parser.parse_args()

    sample_rate, pcm = synthesize(args.text)
    device = StackChanUSB(args.port)
    try:
        device.handshake()
        print(f'Connected to Stack-Chan on {args.port}')
        device.request_animation(args.animation)
        print(f'Playing animation: {args.animation}')
        device.play_pcm(sample_rate, pcm)
        print(f'Spoke: {args.text}')
    finally:
        device.close()


if __name__ == '__main__':
    main()
