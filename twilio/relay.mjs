/**
 * ConversationRelay — the live voice socket.
 *
 * Twilio holds the call, does the speech-to-text and the text-to-speech, and
 * talks to us over a WebSocket: it sends what the caller said, we send back
 * what to say. That is the whole protocol, and it means the audio never
 * touches this machine — only transcripts do.
 *
 * This is version one and it deliberately does not think. The agent below is
 * a fixed function of its input: it repeats what it heard and names itself.
 * Wiring a live caller straight into the JARVIS reasoning loop is a bigger
 * step than it looks — a stranger's voice becomes a prompt, and that prompt
 * reaches an agent that holds mail, calendar and a phone line — so it gets
 * its own change, with its own gate, once the transport below is proven.
 *
 * Off unless TWILIO_VOICE_MODE=relay. The greeting flow is untouched and
 * remains the default.
 */

import { WebSocketServer } from 'ws'
import { config, maskNumber, redact } from './config.mjs'
import { RateLimit, logEvent, validSignature } from './guard.mjs'
import {
  FALLBACK_LINE,
  GREETING,
  createReceptionist,
  emptyIntake,
  receptionistMode,
} from './receptionist.mjs'

/** A transcript line is short. Anything this size is not ConversationRelay. */
const MAX_MESSAGE_BYTES = 64 * 1024

/** A call that has said nothing for this long is over, whatever Twilio thinks. */
const IDLE_MS = 10 * 60_000

/** One socket per call; a handful of calls at once is a busy small business. */
const MAX_SESSIONS = Number(process.env.TWILIO_RELAY_MAX_SESSIONS ?? 10)

/**
 * Connection attempts are rate limited by source address, before the
 * signature is checked. Verifying a signature is cheap but not free, and an
 * unauthenticated endpoint that will do work for anyone who knocks is how a
 * laptop gets used as an amplifier.
 */
const connectLimit = new RateLimit({
  perKey: Number(process.env.TWILIO_RELAY_CONNECTS_PER_MINUTE ?? 10),
  windowMs: 60_000,
  global: Number(process.env.TWILIO_RELAY_GLOBAL_CONNECTS_PER_MINUTE ?? 30),
})

export const relayEnabled = () => (process.env.TWILIO_VOICE_MODE ?? 'greeting') === 'relay'

export const relayUrl = () => process.env.TWILIO_RELAY_WEBSOCKET_URL?.trim() || null

export const relayGreeting = () => process.env.TWILIO_RELAY_GREETING?.trim() || GREETING

// --------------------------------------------------------------------------
// The agent
// --------------------------------------------------------------------------

/**
 * Version one: deterministic, and provably so.
 *
 * Separated out behind this one function so that replacing it with the real
 * reasoning loop is a single, reviewable change — everything around it
 * (transport, signatures, limits, logging) stays exactly as tested.
 *
 * @param {{ voicePrompt: string, lang?: string }} prompt
 * @param {{ callSid?: string }} session
 * @returns {{ text: string }}
 */
export function testReceptionist(prompt, session = {}) {
  void session
  const heard = String(prompt.voicePrompt ?? '').trim()
  return { text: `I heard you say: ${heard}. This is the JARVIS test receptionist.` }
}

// --------------------------------------------------------------------------
// Speaking
// --------------------------------------------------------------------------

/**
 * A ConversationRelay text message, in the shape Twilio expects.
 *
 * `last: true` says this is a complete utterance rather than one token of a
 * stream — correct here because the answer is computed in one go. A streaming
 * agent would send many of these with `last: false` and one with `last: true`.
 *
 * `interruptible: true` lets the caller talk over it, which is what makes a
 * voice assistant feel like a conversation rather than a recording.
 * `preemptible: false` means our own later messages will not cut this one off
 * mid-sentence.
 */
export const textMessage = (token, { last = true, interruptible = true, preemptible = false } = {}) => ({
  type: 'text',
  token: String(token ?? ''),
  last,
  interruptible,
  preemptible,
})

// --------------------------------------------------------------------------
// One call
// --------------------------------------------------------------------------

/**
 * Drives a single connected call. Exported so the self-test can run a whole
 * conversation through it without a socket, and so the message handling is
 * testable separately from the transport that carries it.
 */
export function createSession(send, { receptionist, onHandoff } = {}) {
  const state = {
    callSid: null,
    from: null,
    to: null,
    sessionId: null,
    turns: 0,
    // Per-call, in memory, and gone when the call is. The receptionist reads
    // and writes these; nothing else does.
    intake: emptyIntake(),
    history: [],
  }

  // One receptionist per call, so a session can never see another's history.
  const agent = receptionist ?? createReceptionist()

  return {
    state,
    agent,

    /** @param {object} message one decoded ConversationRelay message */
    async handle(message) {
      const type = message?.type

      switch (type) {
        case 'setup': {
          state.sessionId = message.sessionId ?? null
          state.callSid = message.callSid ?? null
          state.from = message.from ?? null
          state.to = message.to ?? null
          // Masked before it is handed to the logger, not after.
          //
          // logEvent masks numbers on the console but writes the raw value to
          // the file, which is right for an SMS record. It is not right here:
          // this file also holds the transcript of what was said on the call,
          // and a full number sitting beside that is a materially different
          // record to keep on a laptop. Masking is idempotent, so the console
          // line is unaffected.
          logEvent('relay.setup', {
            sid: state.callSid,
            from: maskNumber(state.from),
            to: maskNumber(state.to),
            direction: message.direction ?? null,
          })
          return null
        }

        case 'prompt': {
          // Twilio sends partial transcripts as the caller speaks. Answering
          // a half-finished sentence means talking over them, so only a final
          // one gets a reply.
          if (message.last === false) return null

          const heard = String(message.voicePrompt ?? '').trim()
          if (!heard) return null

          state.turns++

          // The receptionist is the only thing that decides what is said.
          // Its guards live inside it, so this transport cannot accidentally
          // route around them.
          let reply
          try {
            reply = await agent.respond(heard, state)
          } catch (err) {
            // Belt and braces: the receptionist already catches its own
            // failures, so reaching here means something unexpected. A caller
            // waiting in silence is the one outcome not allowed.
            logEvent('relay.receptionist_failed', {
              sid: state.callSid,
              reason: redact(err?.message ?? String(err)),
            })
            reply = { say: FALLBACK_LINE, handoff: true, source: 'transport-error' }
          }

          logEvent('relay.prompt', {
            sid: state.callSid,
            chars: heard.length,
            lang: message.lang ?? null,
            status: reply.source ?? 'unknown',
            // The business record keeps what was said; the console line above
            // gets only the length. Same split as an SMS body.
            body: heard,
            reply: reply.say,
          })

          const out = textMessage(reply.say)
          send?.(out)

          // A handoff is a request to get a person, not a permission grant:
          // it is recorded and surfaced, and the existing transfer path is
          // what actually moves the call.
          if (reply.handoff) {
            logEvent('relay.handoff_requested', { sid: state.callSid, status: reply.source ?? '' })
            onHandoff?.(state)
          }
          return out
        }

        case 'dtmf': {
          const digit = String(message.digit ?? '')
          logEvent('relay.dtmf', { sid: state.callSid, status: `digit ${digit}` })
          // Acknowledged, not acted on. Turning a keypress into a transfer is
          // the obvious next step and belongs with the change that adds a
          // <Connect action> handoff, not smuggled in here.
          const out = textMessage(
            `I heard you press ${digit}. This is the JARVIS test receptionist.`,
          )
          send?.(out)
          return out
        }

        case 'interrupt': {
          // The caller spoke over us. Nothing to send — the point of an
          // interrupt is that we stop — but it is recorded, because a call
          // full of interruptions means the answers are too long.
          logEvent('relay.interrupt', {
            sid: state.callSid,
            chars: String(message.utteranceUntilInterrupt ?? '').length,
          })
          return null
        }

        case 'error': {
          logEvent('relay.error', {
            sid: state.callSid,
            reason: redact(String(message.description ?? 'unknown')),
          })
          return null
        }

        default: {
          logEvent('relay.unknown_message', { sid: state.callSid, status: String(type ?? 'none') })
          return null
        }
      }
    },
  }
}

// --------------------------------------------------------------------------
// The transport
// --------------------------------------------------------------------------

/**
 * Whether this upgrade request is really Twilio.
 *
 * Twilio signs the WebSocket handshake the same way it signs a webhook, except
 * a handshake is a GET: the signed payload is the URL alone, with no
 * parameters appended. The URL has to be the exact public wss address Twilio
 * was told to connect to — which is why it comes from
 * TWILIO_RELAY_WEBSOCKET_URL and never from the request's own Host header.
 *
 * Fails closed in every direction: no auth token, no configured URL, or no
 * signature header all mean refused. An unverified socket here is a stranger
 * with a microphone into the system.
 */
export function relayHandshakeAllowed(req) {
  const { authToken } = config()
  const url = relayUrl()
  if (!authToken) return { ok: false, code: 503, reason: 'no auth token configured' }
  if (!url) return { ok: false, code: 503, reason: 'TWILIO_RELAY_WEBSOCKET_URL is not set' }

  const given = req.headers['x-twilio-signature']
  const signature = Array.isArray(given) ? given[0] : given
  if (!signature) return { ok: false, code: 403, reason: 'no signature on the handshake' }

  // A GET is signed over the bare URL. Any query string Twilio appends is
  // part of that URL, so it is included as received rather than discarded.
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const signedUrl = `${url}${query}`
  if (!validSignature(authToken, signedUrl, {}, signature)) {
    return { ok: false, code: 403, reason: 'bad handshake signature' }
  }
  return { ok: true }
}

/**
 * Attaches the relay to an existing HTTP server.
 *
 * Shares the gateway's port on purpose: it is the one thing already exposed
 * through the tunnel, it already has the signature machinery, and a second
 * public listener would be a second thing to get wrong. The bridge on 8787 is
 * not involved at any point.
 */
export function attachRelay(server, { onSession } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const sessions = new Set()

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/twilio/voice/relay') {
      socket.destroy()
      return
    }

    const refuse = (code, reason) => {
      logEvent('relay.rejected', { reason })
      socket.write(`HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : 'Service Unavailable'}\r\n\r\n`)
      socket.destroy()
    }

    if (!relayEnabled()) {
      return refuse(503, 'relay mode is off (TWILIO_VOICE_MODE is not relay)')
    }

    const taken = connectLimit.take(req.socket.remoteAddress ?? 'unknown')
    if (!taken.ok) return refuse(429, `too many connection attempts (${taken.scope})`)

    if (sessions.size >= MAX_SESSIONS) return refuse(503, 'too many live calls')

    const allowed = relayHandshakeAllowed(req)
    if (!allowed.ok) return refuse(allowed.code, allowed.reason)

    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions.add(ws)

      const send = (payload) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
      }
      const session = createSession(send)
      onSession?.(session)

      let idle = setTimeout(() => ws.close(1000, 'idle'), IDLE_MS)
      const touch = () => {
        clearTimeout(idle)
        idle = setTimeout(() => ws.close(1000, 'idle'), IDLE_MS)
      }

      ws.on('message', async (raw) => {
        touch()
        let message
        try {
          message = JSON.parse(raw.toString())
        } catch {
          logEvent('relay.bad_json', { sid: session.state.callSid })
          return
        }
        try {
          await session.handle(message)
        } catch (err) {
          // One malformed turn must not drop a live call.
          logEvent('relay.handler_failed', {
            sid: session.state.callSid,
            reason: redact(err.message),
          })
        }
      })

      ws.on('close', () => {
        clearTimeout(idle)
        sessions.delete(ws)
        // The point of the call: what was taken down about the job. Numbers
        // inside it are the caller's own callback, which is the record's
        // reason for existing, so it is kept as given — this file is 0600 and
        // outside the repository.
        logEvent('relay.closed', {
          sid: session.state.callSid,
          status: `${session.state.turns} turn(s)`,
          intake: session.state.intake,
        })
      })

      ws.on('error', (err) => {
        logEvent('relay.socket_error', { reason: redact(err.message) })
      })
    })
  })

  return {
    get sessions() {
      return sessions.size
    },
    close() {
      for (const ws of sessions) ws.close(1000, 'shutting down')
      wss.close()
    },
  }
}

export const relayStatus = () => ({
  mode: process.env.TWILIO_VOICE_MODE ?? 'greeting',
  enabled: relayEnabled(),
  // The URL is public by nature — Twilio is told it, and it is in the TwiML —
  // so it is safe to report. The masked numbers rule is about callers.
  websocket_url: relayUrl(),
  agent:
    receptionistMode() === 'ai'
      ? `restricted AI receptionist (${process.env.TWILIO_RECEPTIONIST_MODEL?.trim() || 'claude-opus-5'}, no tools)`
      : 'test-receptionist (deterministic, no model)',
  receptionist_mode: receptionistMode(),
})

export { maskNumber }
