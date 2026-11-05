# DSH Link (3DS)

Pair a modded New 3DS XL by scanning a QR code, then drive ordinary DeepSeek
Harness sessions from the console: type a message, hold to talk, or write with
the stylus. Replies appear as text on the top screen.

The plugin runs a plain-HTTP bridge on the LAN and advertises it as a QR code in
**Settings → 3DS Link**. The 3DS app is a devkitARM/libctru homebrew program in
[`3ds/`](3ds/README.md).

## Why a LAN bridge

A stock 3DS has no usable TLS stack for the Harness origin, and the Harness
itself is not a 3DS-shaped API. The bridge is the small surface the console can
actually speak: token-authenticated JSON over HTTP, a session list, a transcript
poll, and three input endpoints.

```text
3DS app ---- HTTP :7080 ----> dsh-3ds Host bridge ----> ctx.sessionController
   |                              |                        + ctx.speechToText
   |  QR from Settings            |                        + ctx.attachments
   +------------------------------+
```

The bridge never creates a second session store: sessions it lists, resumes, and
prompts are the same live sessions the Web GUI shows.

## Use

1. Install the bundle (already installed in this profile):

   ```sh
   # from a DSH session, through plugin_manager
   install_bundle target=/absolute/path/to/packages/dsh-3ds
   ```

2. Open **Settings → 3DS Link** in the Web GUI. The QR encodes the bridge URL
   and token; the page also shows the LAN address and token for manual entry.

3. Build and install the console app:

   ```sh
   packages/dsh-3ds/3ds/build.sh
   ```

   Copy `3ds/dsh-link.3dsx` to `sdmc:/3ds/dsh-link.3dsx` on the SD card, then
   launch it from the Homebrew Launcher.

4. Scan the QR. The app saves the pairing to
   `sdmc:/3ds/dsh-link/config.txt`; later launches skip the camera.

The console must be on the same LAN as the Host. Port `7080` must be open on the
Host firewall; this machine already allows it with
`ufw allow 7080/tcp`.

## Controls

| Screen | Input | Action |
| --- | --- | --- |
| Chat | A / Text | Type a message with the system keyboard |
| Chat | Y / Voice (hold) | Record; release to transcribe and send |
| Chat | X / Note | Write with the stylus and send as a vision prompt |
| Chat | B / Sessions | Pick another session |
| Chat | D-pad ↑ / ↓ | Scroll the transcript |
| Sessions | Tap a row, A, X, B | Open, new session, back |
| Note | Send / Clear / Back | Upload, erase, or discard |
| Any | START | Exit to the Homebrew Launcher |

The bridge returns assistant text, not audio. The 3DS has no TTS playback in
this app.

## Bridge API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/hello` | Pair check and initial session list |
| `GET` | `/api/sessions` | Refresh session rows |
| `POST` | `/api/session/new` | Create and select a session |
| `GET` | `/api/state?sessionId=&after=` | Transcript since a sequence |
| `POST` | `/api/prompt?sessionId=` | `{ "text": "..." }` |
| `POST` | `/api/voice?sessionId=` | 16 kHz mono PCM16 WAV bytes |
| `POST` | `/api/ink?sessionId=` | `{ width, height, strokes: [[x,y,...]] }` |
| `POST` | `/api/cancel?sessionId=` | Cancel the active turn |

Every endpoint except `/api/health` requires `X-3DS-Token` (or `?token=`).

## Configuration

`cordis.patch.yml` sets the row:

```yaml
- insert:
    - id: 3ds-bridge
      name: '@local/dsh-3ds'
      config:
        port: 7080
```

Optional fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | `0.0.0.0` | bind address |
| `port` | `7080` | LAN listener; a future restart may pick another if busy |
| `advertiseHost` | first LAN IPv4 | address inside the QR (set it when the Host has several networks) |
| `language` | `en` | speech hint passed to `ctx.speechToText` |
| `cwd` | Harness default | directory for sessions created from the console |

The pairing token lives at `$DSH_HOME/3ds-bridge.json` with mode `0600`. If the
camera is unavailable, press **X** on the pairing screen and enter the address
and token shown in Settings. Delete the file and remount the plugin to rotate;
the old QR stops working.

## Security

- The bridge is plain HTTP by design. It carries a bearer token, so keep it on a
  trusted LAN and do not expose port 7080 to the internet.
- The QR and status routes are registered on the authenticated Web server; the
  QR is rendered per request with a `no-store` cache header.
- The token is the only credential the console stores. The bridge only accepts
  requests carrying it in constant time.
- Voice is transcribed by the composed Voice Input provider; the audio is not
  written to disk by this plugin.
- Ink is rendered to a PNG and admitted through the ordinary prompt attachment
  path; the image persists wherever the session's attachments persist.

## Verification status

Verified on this Host:

- Bundle installs and the LAN listener binds (`/api/health`).
- QR SVG decodes to the expected URL/token/name payload.
- A live session was created through the bridge, prompted with text, and the
  assistant's reply was read back through `/api/state`.
- `/api/voice` transcribed a 16 kHz speech sample and delivered the transcript
  as a prompt; the reply was read back.
- `/api/ink` rendered strokes to a PNG; the vision model read the image and
  replied.
- The Web UI Settings page shows the QR, LAN address, and last-console status.

Not verified here: running the console binary on physical hardware or an
emulator. The 3DSX builds cleanly with devkitARM; camera, microphone, and touch
paths are implemented against libctru but need a device to exercise.

## Development

```sh
node --test packages/dsh-3ds/test/
packages/dsh-3ds/3ds/build.sh
```

The Host half is plain Node ESM plus a vendored MIT QR encoder
(`vendor/qrcode.cjs`). The 3DS app vendors quirc (ISC), cJSON (MIT), and the
public-domain `font8x8_basic` font.
