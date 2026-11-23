# Owner-provided screenshots and photos

The Owner supplied seven real images through a synced folder, kept outside Git and read-only. All seven were inspected; five clear images were selected. Only reviewed public-safe derivatives are committed under `docs/assets/screenshots/`. No UI state, response, citation, product wording or behavior was fabricated. No generated replacement screenshot is included.

These captures show an earlier working Local AI interface, including its original name, mascot, colors and status messages. They are not captures of the exact Public V1 build. The IA342 image shows a Local answer, not an expanded citation panel. They do not establish current answer correctness, speech accuracy or Public V1 hardware readiness. The Owner subsequently approved a History dashboard capture for the History guide; this specific public demo record is an exception to the default prohibition on real History captures. No database or other runtime record was read or imported.

| Owner source filename              | Public derivative                               | Edits                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Screenshot 2026-09-26 134032.png` | `assets/screenshots/laita-main-chat.png`        | No crop, resize or text/pixel alteration; converted to metadata-free RGB PNG, 1267 × 1252.                                                          |
| `1790082677781.jpeg`               | `assets/screenshots/laita-course-grounding.png` | No crop, resize or text alteration; decoded to metadata-free RGB PNG, 1238 × 1126.                                                                  |
| `2026-09-21 18.33.52.jpg`          | `assets/screenshots/laita-pi-client.jpg`        | Crop `(0, 1060, 2680, 2840)` in the 3064 × 4080 source removes excess surroundings; resize to 1600 × 1063. Screen content preserved.                |
| `Screenshot 2026-10-01 224750.png` | `assets/screenshots/laita-history-review.png`   | No crop, resize or UI/text/pixel alteration; metadata-free RGB PNG, 1234 × 918. Placed in History docs.                                             |
| `2026-09-21 18.37.19.jpg`          | `assets/screenshots/laita-mac-mini.jpg`         | Crop `(250, 200, 2380, 1600)` in the 3064 × 4080 source; opaque polygon covers the entire institutional asset label/barcode; resize to 1600 × 1052. |

Crop coordinates use `(left, top, right, bottom)` in source pixels. The redaction polygon in the Mac photo uses `(1568,916), (1738,663), (1932,735), (1748,995)`. The private identifier itself is not transcribed here. EXIF, XMP, ICC profiles and inherited comments were stripped from all derivatives; only image-format encoding metadata remains. No color/style correction, generative fill, UI substitution or model text replacement was applied.

`1790082677797.jpeg` and `Screenshot 2026-09-26 133953.png` were inspected but not selected because the chosen chat/course images give clearer, less redundant coverage. Original names, bytes and locations were unchanged; source hashes were verified again after processing. Every final image derivative was inspected at its full output resolution for private identifiers, student information, keys/tokens, paths/hostnames and unrelated private content before commit. None remained visible. Hashes/protected source paths stay in local review evidence, outside Git.

Owner authorization covers these specific public derivatives. Incidental product marks and public course wording retain their existing rights and do not imply endorsement; see [third-party boundaries](../THIRD_PARTY.md).

## Real demo video

The Owner also supplied `pi-ta-demo-final.mp4`: a 27.8-second, 1080 × 1920 H.264/AAC recording of an earlier Raspberry Pi MVP. It shows general voice input, explicit Llama/Gemma switching, a demo-course question, a real Local text answer and the Course sources control. The existing “Still waiting for my speaker” / speech-unavailable wording is preserved. It does not demonstrate successful audible answer playback, the current Public V1 build, universal speech language support, or verified answer correctness.

- `assets/demo/laita-pi-demo.mp4`: full-duration 720 × 1280 presentation copy, about 1.99 MB, with inherited metadata stripped and fast-start layout. Video was resized/re-encoded to satisfy the existing 5 MB repository file limit; audio was stream-copied and decoded audio samples match the Owner source. No UI/response edits, redactions, replacement audio or new cuts were needed.
- `assets/demo/laita-demo.gif`: silent excerpt from source seconds **15.8–27.8**, 12 seconds at normal playback speed, 320 × 569, 6 fps, 64-color palette, about 1.36 MB. Resizing, frame sampling and GIF palette conversion are presentation encoding only. The original recording already shortens a waiting period and says so; no additional acceleration was applied.

Source review used full-sequence contact sheets, 28 full-resolution one-second samples, individual camera/UI views, local OCR and local audio review/transcription. Speech contains two general demo questions; no student names, keys, hostnames, operational paths or private identifiers were found in the reviewed video/audio. The final GIF's 72 frames were inspected at their full output resolution; the full MP4's decode/metadata, resized visual content and unchanged audio were verified. The Dashboard image was inspected at full resolution: only an Owner-approved public demo question/answer, source/model UI and its real timestamp are visible. Its decoded pixels match the original. All source files remain outside Git with unchanged hashes. No internal JSON, handoff, scripts or other files from the video directory were imported.

These exact media derivatives have Owner authorization. That permission does not permit importing other real conversations, History screenshots, recordings or operational material.

## v0.2.0 sandbox Canvas demo

`assets/demo/laita-v020-canvas.gif` is the Owner-provided, Owner-authorized derivative for Public repository use, supplied in PR #51: a 960 × 540 animated GIF showing Canvas → LAITA launch/demo. It visibly displays **SANDBOX ONLY** and **No real student or teacher data.** No real student or teacher data, credentials, consumer key, shared secret, API token, private hostname or private operational path is present. No UI or state was fabricated. The supplied GIF is committed unchanged; the separate social-media MP4 is not included. This sandbox demonstration is not universal Canvas/browser acceptance evidence.

## Synthetic phone captures

The [install guide](assets/screenshots/laita-phone-entry.png) and [phone composer](assets/screenshots/laita-phone-chat.png) show the built UI at 390 × 844 in Chromium. The local browser fixture uses synthetic responses and captures the app without browser chrome. The PNGs contain no participant records, credentials, or operator endpoints. Their metadata was stripped. Physical iPhone installation remains unverified.

The 180, 192 and 512 pixel app icons in `apps/web/public/assets/pwa/` are raster renders of the repository's LAITA wordmark.

## v0.3.0 published presentation assets — DEV synthetic provenance

The following media were taken **only from Owner-supplied DEV preview files in the shared LAITA Drive collection** and published as separate v0.3.0 presentation assets. They visually communicate the intended workflows but **do not demonstrate exact Public v0.3.0 UI/version identity** or successful live Canvas integration. Every GIF visibly says **Development Preview** and **Sandbox demonstration · Demo data**. Some DEV controls (notably delegated Admin controls and published-item choices) exceed current Public scope; those images are captioned accordingly. Public acceptance must be measured against Public code/tests, not screenshots.

| Repository media | Owner source | Processing | Intended reference |
| --- | --- | --- | --- |
| `assets/demo/v030-dev/01-Website-Roles.gif` | `01-Website-Roles.gif` | Unchanged GIF, 1,634,669 bytes | DEV role views; **Admin controls are not all Public features** |
| `assets/demo/v030-dev/02-Student-in-Canvas.gif` | `02-Student-in-Canvas.gif` | Unchanged GIF, 2,157,047 bytes | Demo Student course-grounded Chat |
| `assets/demo/v030-dev/03-Teacher-Chat.gif` | `03-Teacher-Chat.gif` | Unchanged GIF, 2,646,129 bytes | Teacher Canvas and History paths |
| `assets/demo/v030-dev/04-Teacher-Generate-excerpt.gif` | `04-Teacher-Generate.gif` | **First 220 of 422 GIF frames**, unaltered frame data; 2,612,262 bytes | Editable content generation and Canvas creation excerpt |
| `assets/demo/v030-dev/05-Teacher-Verify.gif` | `05-Teacher-Verify.gif` | Unchanged GIF, 2,393,950 bytes | Configured practice GitHub/MongoDB checks and separate feedback |
| `assets/demo/v030-dev/06-Mobile-PWA-excerpt.gif` | `laita-pwa-demo-v5.gif` | **First 108 of 297 GIF frames**, unaltered frame data; 1,895,919 bytes | Early mobile/PWA interaction excerpt |

The two shortened clips end at original complete GIF-frame boundaries; their global palettes and prior frames are retained, with no synthesized UI, audio or altered words. The larger complete source GIFs remain unchanged in Drive. The excerpts do not reproduce events after the cuts; see the accompanying still images and step-by-step Public workflow text.

| Repository screenshot | Owner source | Presentation |
| --- | --- | --- |
| `assets/screenshots/v030-dev/02h-Complete-course-answer.png` | `02h-Complete-course-answer.png` | Unchanged, source-grounded Demo Student answer |
| `assets/screenshots/v030-dev/04d-Generated-assignment-suggestion.png` | `04d-Generated-assignment-suggestion.png` | Unchanged, editable Local AI assignment suggestion |
| `assets/screenshots/v030-dev/04k-Canvas-module-with-ordered-items.png` | `04k-Canvas-module-with-ordered-items.png` | Unchanged, resulting Canvas Module |
| `assets/screenshots/v030-dev/05e-MongoDB-count-and-sampled-fields.png` | `05e-MongoDB-count-and-sampled-fields.png` | Unchanged, sampled read-only MongoDB observations |

**Media handling and remaining review:** The four full GIFs and two excerpt sources were opened; 15 distributed frames from each complete GIF were reviewed as contact sheets and all four selected screenshots were inspected in full resolution. The files have no retained EXIF/comment/ICC/XMP description metadata visible to the decoder. The sampled material shows synthetic/demo identities and the already labeled preview; no obvious passwords or private student identities appeared in the inspected samples. **This is not a guarantee of full-frame privacy certification** and not exact-Public UI acceptance. The Owner approved publication of these exact DEV-origin assets for v0.3.0; the documented sampling is a bounded review, not full-frame privacy certification or proof of exact Public UI parity.

The repository intentionally disallows **unreviewed image paths** in `scripts/ci/check-public-boundary.mjs`. The ten exact media paths were admitted in merged PR #115 with negative tests, **without disabling the public-boundary check or admitting arbitrary new images**. The assets are included in the released v0.3.0 source tag.

Older v0.2.0/demo imagery stays under its original names and version labels for historical provenance; the README now prioritizes the newer Owner-provided DEV previews with conspicuous provenance rather than using the older animation as its headline image.
