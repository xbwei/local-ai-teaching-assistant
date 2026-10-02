# Optional local speech

Text chat works without speech assets. A selected model may answer text in other languages; that general model capability is separate from the speech adapters. The current reference speech contract and synthetic validation cover English and Chinese only. The upstream model name “Small Multilingual” does not claim that LAITA validates every language it can recognize. The accepted reference adapters use whisper.cpp **1.8.3 Small Multilingual** for English/Chinese recognition and macOS voices for English/Chinese spoken replies. They do not call a Cloud speech API. Browser microphone input requires the operator-controlled HTTPS secure context and permission; mute/text-only and Stop audio remain explicit controls.

Install whisper.cpp outside Git from its official [repository](https://github.com/ggml-org/whisper.cpp), using source commit `2eeeba56e9edd762b4b38467bab96c2517163158`. Build `whisper-cli` according to upstream instructions. Download `ggml-small.bin` (multilingual, not `small.en`). The accepted model is 487601967 bytes with SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`. A different model/binary must not silently substitute itself. Verify origin, license, size and digest yourself; assets are not bundled.

Use canonical paths in owner-controlled directories with no writable untrusted ancestors. The binary/model must be regular owner-controlled files, not symlinks/hardlinks. Create the following **non-secret** profile outside Git in a protected directory, mode 0600, replacing each placeholder with your own path and the SHA-256 of your approved compiled binary:

```json
{
  "identity": "whisper.cpp/1.8.3/small-multilingual/ggml-f16",
  "binary": "/absolute/operator/speech/whisper-cli",
  "binarySha256": "REPLACE_WITH_VERIFIED_64_HEX_BINARY_SHA256",
  "model": "/absolute/operator/speech/ggml-small.bin"
}
```

This is a structural example; placeholders are deliberately invalid until replaced. The loader verifies permissions and both assets. Set `features.speech` to true in the full v4 config and `LAITA_STT_PROFILE` to the canonical profile path when starting the foreground API. Restart explicitly. For the generic service runner place the profile at `$LAITA_DEPLOY_ROOT/private/stt-profile.json`.

Inspect `/usr/bin/say -v '?'` on your own Mac and install appropriate English/Chinese voices in macOS settings. The adapter selects available local voices; unavailable adapters fail visibly. Do not claim recording/transcription readiness from configuration alone.

The service bounds recording/synthesis, preserves successful transcript text, and cleans temporary raw/generated audio on job/session termination. Long replies deliberately skip spoken synthesis rather than truncate retained text. Text-only, autoplay restrictions, user gesture, cancellation and playback results are separately represented. See the synthetic short/long speech tests for exact bounds; real microphone/voice quality and physical Pi behavior still need operator acceptance.

A Pi runs only the browser. A remote thin client needs a separately protected operator-only HTTPS entry and CA trust, not the loopback Caddyfile unchanged. Do not expose History to a shared classroom or Internet entry merely to make a Pi connect. Test browser display/audio, then microphone and actual bilingual transcription, before claiming physical readiness.
