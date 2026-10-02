# Owner-provided screenshots and photos

The Owner supplied seven real images through a synced folder, kept outside Git and read-only. All seven were inspected; five clear images were selected. Only reviewed public-safe derivatives are committed under `docs/assets/screenshots/`. No UI state, response, citation, product wording or behavior was fabricated. No generated replacement screenshot is included.

These captures show an earlier working Local AI interface, including its original name, mascot, colors and status messages. They are not captures of the exact Public V1 build. The IA342 image shows a Local answer, not an expanded citation panel. They do not establish current answer correctness, speech accuracy or candidate hardware readiness. The Owner subsequently approved a History dashboard capture for the History guide; this specific public demo record is an exception to the default prohibition on real History captures. No database or other runtime record was read or imported.

| Owner source filename | Public derivative | Edits |
|---|---|---|
| `Screenshot 2026-09-26 134032.png` | `assets/screenshots/laita-main-chat.png` | No crop, resize or text/pixel alteration; converted to metadata-free RGB PNG, 1267 × 1252. |
| `1790082677781.jpeg` | `assets/screenshots/laita-course-grounding.png` | No crop, resize or text alteration; decoded to metadata-free RGB PNG, 1238 × 1126. |
| `2026-09-21 18.33.52.jpg` | `assets/screenshots/laita-pi-client.jpg` | Crop `(0, 1060, 2680, 2840)` in the 3064 × 4080 source removes excess surroundings; resize to 1600 × 1063. Screen content preserved. |
| `Screenshot 2026-10-01 224750.png` | `assets/screenshots/laita-history-review.png` | No crop, resize or UI/text/pixel alteration; metadata-free RGB PNG, 1234 × 918. Placed in History docs. |
| `2026-09-21 18.37.19.jpg` | `assets/screenshots/laita-mac-mini.jpg` | Crop `(250, 200, 2380, 1600)` in the 3064 × 4080 source; opaque polygon covers the entire institutional asset label/barcode; resize to 1600 × 1052. |

Crop coordinates use `(left, top, right, bottom)` in source pixels. The redaction polygon in the Mac photo uses `(1568,916), (1738,663), (1932,735), (1748,995)`. The private identifier itself is not transcribed here. EXIF, XMP, ICC profiles and inherited comments were stripped from all derivatives; only image-format encoding metadata remains. No color/style correction, generative fill, UI substitution or model text replacement was applied.

`1790082677797.jpeg` and `Screenshot 2026-09-26 133953.png` were inspected but not selected because the chosen chat/course images give clearer, less redundant coverage. Original names, bytes and locations were unchanged; source hashes were verified again after processing. Every final image derivative was inspected at its full output resolution for private identifiers, student information, keys/tokens, paths/hostnames and unrelated private content before commit. None remained visible. Hashes/protected source paths stay in local review evidence, outside Git.

Owner authorization covers these specific public derivatives. Incidental product marks and public course wording retain their existing rights and do not imply endorsement; see [third-party boundaries](../THIRD_PARTY.md).

## Real demo video

The Owner also supplied `pi-ta-demo-final.mp4`: a 27.8-second, 1080 × 1920 H.264/AAC recording of an earlier Raspberry Pi MVP. It shows general voice input, explicit Llama/Gemma switching, a demo-course question, a real Local text answer and the Course sources control. The existing “Still waiting for my speaker” / speech-unavailable wording is preserved. It does not demonstrate successful audible answer playback, the current Public V1 build, universal speech language support, or verified answer correctness.

- `assets/demo/laita-pi-demo.mp4`: full-duration 720 × 1280 presentation copy, about 1.99 MB, with inherited metadata stripped and fast-start layout. Video was resized/re-encoded to satisfy the existing 5 MB repository file limit; audio was stream-copied and decoded audio samples match the Owner source. No UI/response edits, redactions, replacement audio or new cuts were needed.
- `assets/demo/laita-demo.gif`: silent excerpt from source seconds **15.8–27.8**, 12 seconds at normal playback speed, 320 × 569, 6 fps, 64-color palette, about 1.36 MB. Resizing, frame sampling and GIF palette conversion are presentation encoding only. The original recording already shortens a waiting period and says so; no additional acceleration was applied.

Source review used full-sequence contact sheets, 28 full-resolution one-second samples, individual camera/UI views, local OCR and local audio review/transcription. Speech contains two general demo questions; no student names, keys, hostnames, operational paths or private identifiers were found in the reviewed video/audio. The final GIF's 72 frames were inspected at their full output resolution; the full MP4's decode/metadata, resized visual content and unchanged audio were verified. The Dashboard image was inspected at full resolution: only an Owner-approved public demo question/answer, source/model UI and its real timestamp are visible. Its decoded pixels match the original. All source files remain outside Git with unchanged hashes. No internal JSON, handoff, scripts or other files from the video directory were imported.

These exact media derivatives have Owner authorization. That permission does not permit importing other real conversations, History screenshots, recordings or operational material.
