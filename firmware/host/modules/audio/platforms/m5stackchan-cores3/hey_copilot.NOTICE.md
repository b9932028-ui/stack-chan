# Hey Copilot model

`hey_copilot.tflite` is a custom microWakeWord streaming model trained locally
for this project. It is not an upstream model. The full training record,
including dataset sources, settings, results and the problems hit along the
way, is in `REVIEW_wake-word_en.md` §9 at the repository root.

- Framework: [`OHF-Voice/micro-wake-word`](https://github.com/OHF-Voice/micro-wake-word)
  `4665173`, with the three Windows/WSL2 patches from
  [`malonestar/custom-micro-wake-word-model`](https://github.com/malonestar/custom-micro-wake-word-model)
- Positive samples: 50,000 Piper TTS clips (`en_US-libritts_r-medium`)
- Architecture: mixednet, 26,049 parameters, streaming int8 quantized
- Model size: 62,304 bytes
- SHA-256: `99C9B79CAA78CA7F269599BBAF8D36FCB4667F3D3D347E47D8F56CA8FB2D6278`
- Wake word: `Hey Copilot`
- Probability cutoff: `0.87` (see `MWW_PROBABILITY_CUTOFF` in `micro-wake-word.cpp`)
- Feature step: `10 ms`
- Sliding window: `5`
- Input / output tensors and op set: identical to `okay_nabu.tflite`

## Licensing

The negative and augmentation datasets used in training (microWakeWord's
pre-generated negative features, AudioSet, Free Music Archive, MIT impulse
responses) carry mixed licences, including CC-BY-NC-4.0. Treat this model as
**non-commercial use only** unless it is retrained on a permissively licensed
negative corpus.
