/**
 * The Twilio gateway — a separate local service on its own port.
 *
 * Deliberately separate from the bridge. The bridge on 8787 talks to the
 * browser and drives the agent, and it must never be reachable from outside
 * this machine. This service is the only thing a tunnel is ever pointed at,
 * it speaks only Twilio's two webhook shapes, and it refuses anything that
 * does not carry Twilio's signature.
 *
 * It has two faces:
 *
 *   PUBLIC  /twilio/*   reachable through the tunnel, signature-checked
 *   LOCAL   /api/*      loopback only, token-checked, used by JARVIS
 *   OPEN    /health     no secrets in it, so it needs no guard
 */

import { createServer } from 'node:http'
import {
  PORT,
  config,
  controlToken,
  isE164,
  maskNumber,
  readiness,
  redact,
  sameToken,
  toE164,
} from './config.mjs'
import {
  RateLimit,
  destinationAllowed,
  inboundLimit,
  logEvent,
  outboundBurst,
  outboundDaily,
  validSignature,
} from './guard.mjs'
import { CONTENT_TYPE, dialTwiml, sayTwiml, voiceResponse } from './twiml.mjs'
import { placeCall, redirectCall, sendSms } from './client.mjs'
import { attachRelay, relayGreeting, relayStatus, relayUrl } from './relay.mjs'

/** A webhook body is a handful of short fields; anything larger is not Twilio. */
const MAX_BODY = 64 * 1024

/** SMS segments cost money and a runaway prompt could write a novel. */
const MAX_SMS_CHARS = 480

/**
 * Calls currently up, so a transfer has something to transfer.
 *
 * Deliberately in memory: it is worthless after a restart (the calls are gone
 * too) and writing it down would mean a file of who telephoned, which is not
 * something to keep by accident.
 */
const activeCalls = new Map()

const reap = () => {
  const cutoff = Date.now() - 4 * 60 * 60_000
  for (const [sid, call] of activeCalls) if (call.at < cutoff) activeCalls.delete(sid)
}

// --------------------------------------------------------------------------
// Small HTTP helpers
// --------------------------------------------------------------------------

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const xml = (res, body) => {
  res.writeHead(200, { 'content-type': CONTENT_TYPE })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const formToObject = (raw) => Object.fromEntries(new URLSearchParams(raw))

// --------------------------------------------------------------------------
// The two guards
// --------------------------------------------------------------------------

/**
 * A public webhook is only allowed through if Twilio signed it.
 *
 * The URL fed to the check is built from TWILIO_PUBLIC_BASE_URL and never from
 * the request's own Host header — see the note in guard.mjs. Without an auth
 * token there is nothing to check against, so the request is refused rather
 * than waved through: an unverifiable webhook is strictly worse than none.
 */
function checkSignature(req, path, params) {
  const { authToken, publicBaseUrl } = config()
  if (!authToken || !publicBaseUrl) {
    return { ok: false, status: 503, reason: 'gateway not configured for signature checks' }
  }
  const url = `${publicBaseUrl}${path}`
  const given = req.headers['x-twilio-signature']
  if (!validSignature(authToken, url, params, Array.isArray(given) ? given[0] : given)) {
    return { ok: false, status: 403, reason: 'bad signature' }
  }
  return { ok: true }
}

/**
 * The control API is for JARVIS, running on this machine, and nothing else.
 * Loopback alone is not enough — every process on the laptop shares it,
 * including a web page's fetch — so a bearer token is required as well.
 */
function checkControl(req) {
  const remote = req.socket.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return { ok: false, status: 403, reason: 'control API is loopback-only' }

  const header = req.headers.authorization ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!given || !sameToken(given, controlToken())) {
    return { ok: false, status: 401, reason: 'bad control token' }
  }
  return { ok: true }
}

/** Everything an outbound action has to satisfy before it costs money. */
function vetDestination(rawTo, { allowOwner = true } = {}) {
  const to = toE164(rawTo)
  if (!to) {
    return { ok: false, status: 400, error: 'A destination in E.164 form is required, e.g. +447700900123.' }
  }
  const { ownerNumber, fromNumber } = config()
  if (to === fromNumber) {
    return { ok: false, status: 400, error: 'That is this service\'s own number.' }
  }
  if (!allowOwner && to === ownerNumber) {
    return { ok: false, status: 400, error: 'That is the owner\'s number.' }
  }
  const allowed = destinationAllowed(to, ownerNumber)
  if (!allowed.ok) return { ok: false, status: 403, error: allowed.reason }

  for (const [limit, label] of [
    [outboundBurst, 'per-minute'],
    [outboundDaily, 'daily'],
  ]) {
    const taken = limit.take(to)
    if (!taken.ok) {
      return {
        ok: false,
        status: 429,
        error: `Refused by the ${label} ${taken.scope} limit. Try again in ${taken.retryAfter}s.`,
      }
    }
  }
  return { ok: true, to }
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname

  // ---- health, open by design -------------------------------------------
  if (req.method === 'GET' && path === '/health') {
    const state = readiness()
    const { fromNumber, ownerNumber, publicBaseUrl } = config()
    return json(res, state.ready ? 200 : 503, {
      ok: state.ready,
      service: 'jarvis-twilio-gateway',
      port: PORT,
      // Shapes and masks only — this endpoint is deliberately unauthenticated.
      configured: {
        account_sid: Boolean(config().accountSid),
        auth_token: Boolean(config().authToken),
        twilio_number: fromNumber ? maskNumber(fromNumber) : null,
        owner_number: ownerNumber ? maskNumber(ownerNumber) : null,
        public_base_url: publicBaseUrl ?? null,
      },
      voice_mode: process.env.TWILIO_VOICE_MODE ?? 'greeting',
      relay: relayStatus(),
      active_calls: activeCalls.size,
      webhooks: {
        voice: '/twilio/voice/incoming',
        voice_choice: '/twilio/voice/choice',
        voice_status: '/twilio/voice/status',
        messaging: '/twilio/sms/incoming',
        relay_websocket: '/twilio/voice/relay',
      },
      problems: state.problems,
    })
  }

  // ---- inbound webhooks --------------------------------------------------
  if (req.method === 'POST' && path.startsWith('/twilio/')) {
    const params = formToObject(await readBody(req))

    const signed = checkSignature(req, path, params)
    if (!signed.ok) {
      logEvent('webhook.rejected', { path, reason: signed.reason })
      return json(res, signed.status, { error: signed.reason })
    }

    // Rate limited by the number that sent it, after the signature check so a
    // flood of forgeries can never exhaust a real customer's allowance.
    const sender = params.From ?? 'unknown'
    const taken = inboundLimit.take(sender)
    if (!taken.ok) {
      logEvent('webhook.rate_limited', { from: sender, reason: taken.scope })
      res.setHeader('retry-after', String(taken.retryAfter))
      return json(res, 429, { error: 'Too many requests.' })
    }

    if (path === '/twilio/sms/incoming') {
      logEvent('sms.received', {
        from: params.From,
        to: params.To,
        sid: params.MessageSid,
        chars: (params.Body ?? '').length,
        body: params.Body ?? '',
      })
      // An empty <Response/> is an explicit "received, nothing to say back" —
      // auto-replying to every message is a good way to start a loop with
      // another automated system.
      return xml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response/>')
    }

    if (path === '/twilio/voice/incoming') {
      const callSid = params.CallSid
      if (callSid) {
        activeCalls.set(callSid, { from: params.From, to: params.To, at: Date.now() })
        reap()
      }
      logEvent('call.received', { from: params.From, to: params.To, sid: callSid })
      // The mode decides what the caller gets. Relay hands the call to the
      // WebSocket below; greeting — the default — is the untouched flow.
      return xml(
        res,
        voiceResponse(process.env.TWILIO_VOICE_MODE ?? 'greeting', {
          relayWebSocketUrl: relayUrl(),
          welcome: relayGreeting(),
        }),
      )
    }

    if (path === '/twilio/voice/choice') {
      const { ownerNumber, fromNumber } = config()
      if (params.Digits === '1' && ownerNumber) {
        logEvent('call.transfer.caller_requested', {
          from: params.From,
          to: ownerNumber,
          sid: params.CallSid,
        })
        return xml(
          res,
          dialTwiml({
            to: ownerNumber,
            callerId: fromNumber,
            whisper: 'Connecting you now.',
          }),
        )
      }
      return xml(res, sayTwiml('Sorry, I did not catch that. Goodbye.'))
    }

    if (path === '/twilio/voice/status') {
      if (params.CallSid) activeCalls.delete(params.CallSid)
      logEvent('call.status', { sid: params.CallSid, status: params.CallStatus })
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'No such webhook.' })
  }

  // ---- the control API, for JARVIS ---------------------------------------
  if (req.method === 'POST' && path.startsWith('/api/')) {
    const allowed = checkControl(req)
    if (!allowed.ok) {
      logEvent('control.rejected', { path, reason: allowed.reason })
      return json(res, allowed.status, { error: allowed.reason })
    }

    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return json(res, 400, { error: 'Expected a JSON body.' })
    }

    const state = readiness()
    if (!state.ready) return json(res, 503, { error: state.problems.join('; ') })

    try {
      if (path === '/api/sms/send' || path === '/api/reminder/send') {
        const vetted = vetDestination(body.to)
        if (!vetted.ok) return json(res, vetted.status, { error: vetted.error })

        const text =
          path === '/api/reminder/send' ? reminderText(body) : String(body.body ?? '')
        if (!text.trim()) return json(res, 400, { error: 'The message is empty.' })
        if (text.length > MAX_SMS_CHARS) {
          return json(res, 400, {
            error: `That message is ${text.length} characters; the limit is ${MAX_SMS_CHARS}.`,
          })
        }

        const sent = await sendSms({ to: vetted.to, body: text })
        logEvent(path === '/api/reminder/send' ? 'reminder.sent' : 'sms.sent', {
          to: vetted.to,
          sid: sent.sid,
          status: sent.status,
          chars: text.length,
          body: text,
        })
        return json(res, 200, { ok: true, sid: sent.sid, status: sent.status })
      }

      if (path === '/api/call/start') {
        const vetted = vetDestination(body.to)
        if (!vetted.ok) return json(res, vetted.status, { error: vetted.error })

        const message = String(body.say ?? '').trim()
        if (!message) return json(res, 400, { error: 'Nothing to say on the call.' })

        const call = await placeCall({ to: vetted.to, twiml: sayTwiml(message) })
        logEvent('call.placed', {
          to: vetted.to,
          sid: call.sid,
          status: call.status,
          chars: message.length,
          body: message,
        })
        return json(res, 200, { ok: true, sid: call.sid, status: call.status })
      }

      if (path === '/api/call/transfer') {
        const { ownerNumber, fromNumber } = config()
        const callSid = String(body.call_sid ?? '').trim() || [...activeCalls.keys()].pop()
        if (!callSid) return json(res, 409, { error: 'There is no call in progress to transfer.' })

        // A transfer goes to the owner's number and nowhere else. Taking a
        // destination here would turn "transfer my call" into an arbitrary
        // dial-out with a customer already on the line.
        const to = ownerNumber
        if (!isE164(to)) return json(res, 503, { error: 'OWNER_PHONE_NUMBER is not set correctly.' })

        const moved = await redirectCall({
          callSid,
          twiml: dialTwiml({ to, callerId: fromNumber, whisper: 'Transferring you now.' }),
        })
        activeCalls.delete(callSid)
        logEvent('call.transferred', { to, sid: callSid, status: moved.status })
        return json(res, 200, { ok: true, sid: callSid, status: moved.status })
      }

      return json(res, 404, { error: 'No such action.' })
    } catch (err) {
      logEvent('action.failed', { path, reason: redact(err.message) })
      return json(res, err.status === 429 ? 429 : 502, { error: redact(err.message) })
    }
  }

  if (req.method === 'GET' && path === '/api/calls/active') {
    const allowed = checkControl(req)
    if (!allowed.ok) return json(res, allowed.status, { error: allowed.reason })
    return json(res, 200, {
      count: activeCalls.size,
      calls: [...activeCalls.entries()].map(([sid, c]) => ({
        sid,
        from: maskNumber(c.from),
        since: new Date(c.at).toISOString(),
      })),
    })
  }

  return json(res, 404, { error: 'Not found.' })
}

/** An appointment reminder, assembled here so every one reads the same. */
export function reminderText({ name, when, service, location, contact }) {
  const who = name ? `Hi ${name}, ` : ''
  const what = service ? ` for ${service}` : ''
  const where = location ? ` at ${location}` : ''
  const how = contact ? ` To change it, call ${contact}.` : ''
  return `${who}a reminder about your appointment${what}${where} on ${when}.${how}`.trim()
}

export function createGateway({ relay = true } = {}) {
  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err.status ?? 500
      logEvent('request.failed', { reason: redact(err.message) })
      if (!res.headersSent) json(res, status, { error: 'Request failed.' })
      else res.end()
    })
  })
  // The relay listens on this same server's upgrade event. It refuses every
  // connection unless TWILIO_VOICE_MODE=relay, so attaching it changes
  // nothing for a gateway running the default greeting flow.
  if (relay) server.relay = attachRelay(server)
  return server
}

/** Started directly (npm run twilio:start) rather than imported by a test. */
const runningDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (runningDirectly) {
  const state = readiness()
  const server = createGateway()
  // Loopback by default. Exposure is a tunnel's job, and a tunnel is a
  // deliberate act; binding 0.0.0.0 by default would put this on the café
  // wifi the first time someone opened a laptop.
  const host = process.env.TWILIO_GATEWAY_HOST ?? '127.0.0.1'
  server.listen(PORT, host, () => {
    console.log(`[twilio] gateway listening on http://${host}:${PORT}`)
    console.log(`[twilio] health: http://${host}:${PORT}/health`)
    if (state.ready) {
      const { publicBaseUrl } = config()
      console.log(`[twilio] voice webhook:     ${publicBaseUrl}/twilio/voice/incoming`)
      console.log(`[twilio] messaging webhook: ${publicBaseUrl}/twilio/sms/incoming`)
      console.log(`[twilio] status callback:   ${publicBaseUrl}/twilio/voice/status`)
      const relayInfo = relayStatus()
      if (relayInfo.enabled) {
        console.log(`[twilio] relay websocket:    ${relayInfo.websocket_url}`)
        console.log(`[twilio] LIVE VOICE RELAY IS ON — callers reach the ${relayInfo.agent}`)
      } else {
        console.log('[twilio] voice mode: greeting (set TWILIO_VOICE_MODE=relay for live voice)')
      }
    } else {
      console.warn('[twilio] not fully configured yet:')
      for (const problem of state.problems) console.warn(`[twilio]   · ${problem}`)
      console.warn('[twilio] webhooks will be refused until these are set.')
    }
    // Touching it here means the file exists before the bridge looks for it.
    controlToken()
    console.log(`[twilio] control token ready for the bridge (~/.jarvis/twilio-gateway.token)`)
  })
}

export { activeCalls, vetDestination, RateLimit }
