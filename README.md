# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

### On a Mac: one command

`scripts/mac-setup.sh` does the whole thing. It checks for Node 20+, Homebrew,
Claude Code and your Claude login, offers to install anything missing, creates
`.env.local`, installs the dependencies, makes sure ports 8787 and 5173 are
free, then starts both halves and opens the app in Chrome.

```bash
git clone https://github.com/Mamoun506-coder/jarvis.git
cd jarvis
bash scripts/mac-setup.sh
```

It asks before installing anything and is safe to run again. Add `--writes` to
allow effectful tools, or `--no-start` to set up without launching. Because the
bridge reads its settings from the shell rather than from `.env.local`, this
script also passes any `JARVIS_*` and `ELEVENLABS_API_KEY` lines you put in
`.env.local` through to it.

### Everywhere else

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Gmail and Calendar

JARVIS can read your mail and your schedule directly, over the Google APIs —
no Chrome open, nothing on screen, no page being scraped.

```
"What emails did I get today?"
"Anything important from Quick Assist customers?"
"What's on my calendar tomorrow?"
```

**Read-only, and enforced at the token.** Two scopes are requested,
`gmail.readonly` and `calendar.readonly`, plus your email address so the status
can name the account. There is no code here that sends, deletes or changes
anything, and if there were, Google would refuse it: the token has never been
granted the right. Mail is fetched as metadata — sender, subject, date and
Gmail's own one-line snippet. Message bodies are never requested.

**Your password is never involved.** Sign-in happens on Google's own pages
(OAuth 2.0, authorization code with PKCE, loopback redirect — what Google
specifies for desktop apps). The bridge only ever holds the tokens that come
back, in `~/.jarvis/google-tokens.json` at `0600`, outside this repository.
Nothing logs a token: the bridge prints counts, never contents.

### Connecting

One-time Google setup, because the OAuth client has to be yours:

1. <https://console.cloud.google.com/apis/credentials> — create a project.
2. Enable the **Gmail API** and the **Google Calendar API**.
3. Configure the OAuth consent screen and add yourself as a test user.
4. **Create credentials → OAuth client ID → Desktop app.**
5. Download the JSON and save it as `~/.jarvis/google-client.json`.

Then:

```bash
npm run google:connect      # opens Google, stores the tokens
npm run google:status       # connected, and as whom
npm run google:disconnect   # forget the tokens on this machine
```

`google:disconnect` removes the tokens from this machine. To revoke access at
Google as well, remove JARVIS at <https://myaccount.google.com/permissions>.

### Status

Four ways to see whether it is linked, which all read the same state:

- **Ask him** — *"are you connected to my Gmail?"* He has a
  `check_google_connection` tool and will say which account, or what to run.
- `npm run google:status`
- The bridge says so on startup: `[jarvis] google connected as you@example.com`
- `GET /google/status` on the bridge, and a `google` flag on `/health`.

---

## Customer communications (Twilio)

A **separate local service** on **port 8788**, so the bridge on 8787 is never
the thing exposed. The gateway speaks only Twilio's two webhook shapes, refuses
anything Twilio did not sign, and is the only process that holds the Twilio
credentials.

```
  internet ──tunnel──▶ :8788 gateway ──loopback──▶ :8787 bridge (never exposed)
                         │  signature-checked          │
                         │  rate-limited               │  four named tools,
                         └─ holds the secrets          └─ holds no secrets
```

### Setting it up

Secrets come from the environment only — there is no file in this repo to put
them in, and nothing is written back to disk:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_PHONE_NUMBER=+15551234567     # the business number
export OWNER_PHONE_NUMBER=+15559876543      # where transfers go
export TWILIO_PUBLIC_BASE_URL=https://your-tunnel.example.com
```

Start it, in its own terminal:

```bash
npm run twilio:start        # http://127.0.0.1:8788
npm run twilio:selftest     # 63 checks, no credentials and no phone calls
```

`GET http://127.0.0.1:8788/health` reports what is configured — as booleans and
masked numbers, never values.

### Webhook paths

Point a tunnel (`cloudflared`, `ngrok`) at **port 8788**, set
`TWILIO_PUBLIC_BASE_URL` to that https address, and configure the number in the
Twilio console:

| Twilio setting | URL | Method |
|---|---|---|
| Voice — "A call comes in" | `{TWILIO_PUBLIC_BASE_URL}/twilio/voice/incoming` | POST |
| Voice — "Call status changes" | `{TWILIO_PUBLIC_BASE_URL}/twilio/voice/status` | POST |
| Messaging — "A message comes in" | `{TWILIO_PUBLIC_BASE_URL}/twilio/sms/incoming` | POST |

`/twilio/voice/choice` is reached from the greeting itself and is not
configured in the console. The base URL must match exactly: Twilio signs the
URL it called, and the gateway verifies against the configured one rather than
the inbound `Host` header, which an attacker controls.

### Letting JARVIS use it

Off by default. The four tools — `send_customer_sms`, `place_customer_call`,
`transfer_call_to_owner`, `send_appointment_reminder` — are enabled by their
**own** switch, which is not `JARVIS_ALLOW_WRITES`:

```bash
JARVIS_ALLOW_COMMS=1 npm start
```

That turns on those four tools and nothing else. Shell, file writes and device
control stay exactly as they were.

### What protects it

- **Signatures.** Every webhook is HMAC-verified against the account auth
  token. Unsigned, mis-signed, or signed for a different path or different
  parameters: all 403.
- **E.164 only.** `+447700900123` is a number; `07700900123` is refused rather
  than guessed at.
- **Rate limits.** Per-sender and global, inbound; per-number burst and daily
  caps, outbound. Premium-rate ranges are refused outright.
- **Transfers go one place.** `transfer_call_to_owner` takes no destination —
  `OWNER_PHONE_NUMBER` is the only place a live call can be sent.
- **The bridge holds no Twilio secret.** It calls the gateway on loopback with
  a local token from `~/.jarvis/twilio-gateway.token` (0600).
- **Logs record the traffic, never the credentials.** The business record is
  `~/.jarvis/twilio-log.jsonl` (0600); the terminal gets masked numbers and no
  message bodies.

### Live AI voice, later

Incoming calls currently get a greeting and a "press 1 for a person" transfer.
`twilio/twiml.mjs` has a `relay` mode for Twilio ConversationRelay already
shaped; switching to it means supplying a WebSocket URL and a conversation
loop. It is deliberately not wired up — it would put a live microphone into an
agent, and that needs its own gate.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
