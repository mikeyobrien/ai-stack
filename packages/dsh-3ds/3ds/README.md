# DSH Link for New 3DS XL

Homebrew client for the DSH Link Host bridge. It scans a pairing QR, lists the
Host's sessions, sends text, records voice, and uploads stylus notes.

## Build

The devkitPro devkitARM image supplies the toolchain and libctru:

```sh
./build.sh          # docker run devkitpro/devkitarm make
./build.sh clean
```

Output:

- `dsh-link.3dsx` — Homebrew Launcher entry
- `dsh-link.smdh` — SMDH metadata embedded in the 3DSX

Copy `dsh-link.3dsx` to `sdmc:/3ds/` and launch it from the Homebrew Launcher.
Luma3DS and a working Wi-Fi connection are required; the app uses `soc:u`,
`cam:u`, and `mic:u`.

The SD card holds one file:

```text
sdmc:/3ds/dsh-link/config.txt
```

It is written after pairing and stores the bridge base URL, token, and last
session id. Delete it to force pairing again.

## Layout

| File | Purpose |
| --- | --- |
| `source/main.c` | screen state machine and flows |
| `source/api.c` | bridge JSON requests |
| `source/net.c` | HTTP/1.1 client over SOC |
| `source/qrscan.c` | camera preview + quirc decode |
| `source/ui.c` | console screens and raw framebuffer drawing |
| `source/mic.c` | MIC sampling and 16 kHz WAV conversion |
| `source/config.c` | SD pairing file |
| `vendor/quirc` | QR decoder (ISC) |
| `vendor/cJSON` | JSON parser (MIT) |
| `vendor/font8x8` | 8×8 font (public domain) |

## Controls

- **A** or **Text**: system keyboard
- **Y** or **Voice** (hold): record, release to transcribe
- **X** or **Note**: stylus canvas; **Send** / **Clear** / **Back**
- **B** or **Sessions**: session picker
- **D-pad**: scroll the transcript or move the session highlight
- **START**: exit

The top screen carries the transcript and status; the bottom screen carries
controls. During pairing the top screen is the camera preview.

## Notes

- The camera preview runs at roughly 8 fps because each frame waits for the
  camera transfer before decoding; this keeps the QR loop simple.
- The microphone is sampled at the hardware rate (16364.479 Hz) and resampled
  linearly to 16 kHz for the Host's WAV validator.
- Assistant replies are text only; there is no audio playback.
- The app polls `/api/state` about once per second and uses the `after` cursor so
  only new events cross the network.
