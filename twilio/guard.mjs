/**
 * The things that stand between the open internet and this gateway.
 *
 * A Twilio webhook URL is a public address. Anything that finds it can POST to
 * it, and what it POSTs looks exactly like a customer calling — which is to
 * say it can make JARVIS act. So nothing here trusts a request until it has
 * proved it came from Twilio, and nothing is allowed to arrive faster than a
 * human plausibly could.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { maskNumber, redact } from './config.mjs'

// --------------------------------------------------------------------------
// Webhook signatures
// --------------------------------------------------------------------------

/**
 * Twilio's scheme, exactly: take the full URL Twilio called, append every POST
 * parameter as key then value in sorted key order, HMAC-SHA1 it with the
 * account's auth token, and base64 the result.
 *
 * The URL has to be the one Twilio *thinks* it called — scheme, host and path
 * as configured in the console — which is why it is built from
 * TWILIO_PUBLIC_BASE_URL rather than from the inbound request's Host header.
 * A Host header is attacker-controlled; using it would let anyone sign their
 * own requests by choosing a host that made their signature check out.
 */
export function expectedSignature(authToken, url, params) {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64')
}

export function validSignature(authToken, url, params, given) {
  if (!authToken || typeof given !== 'string' || !given) return false
  const expected = expectedSignature(authToken, url, params)
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

// --------------------------------------------------------------------------
// Rate limiting
// --------------------------------------------------------------------------

/**
 * A sliding window per key, plus a global one.
 *
 * Two different worries. Inbound, a flood of webhook posts costs CPU and could
 * drive a lot of agent turns; the per-number window keeps one sender from
 * doing that, and the global window keeps a distributed flood from doing it
 * either. Outbound, every message and call costs real money and reaches a real
 * phone, so the caps are deliberately low and the daily one is absolute.
 */
export class RateLimit {
  #hits = new Map()

  constructor({ perKey, windowMs, global: globalMax }) {
    this.perKey = perKey
    this.windowMs = windowMs
    this.globalMax = globalMax ?? Infinity
  }

  /** @returns {{ok: true} | {ok: false, retryAfter: number, scope: string}} */
  take(key, now = Date.now()) {
    const cutoff = now - this.windowMs
    let total = 0
    for (const [k, times] of this.#hits) {
      const kept = times.filter((t) => t > cutoff)
      if (kept.length) this.#hits.set(k, kept)
      else this.#hits.delete(k)
      total += kept.length
    }

    const mine = this.#hits.get(key) ?? []
    if (mine.length >= this.perKey) {
      return {
        ok: false,
        scope: 'sender',
        retryAfter: Math.ceil((mine[0] + this.windowMs - now) / 1000),
      }
    }
    if (total >= this.globalMax) {
      return { ok: false, scope: 'global', retryAfter: Math.ceil(this.windowMs / 1000) }
    }
    this.#hits.set(key, [...mine, now])
    return { ok: true }
  }

  /** Test seam, and useful when a gateway is restarted deliberately. */
  reset() {
    this.#hits.clear()
  }
}

/**
 * Inbound: generous enough for a real conversation (a person texting quickly),
 * tight enough that a script gets nowhere.
 */
export const inboundLimit = new RateLimit({
  perKey: Number(process.env.TWILIO_INBOUND_PER_MINUTE ?? 20),
  windowMs: 60_000,
  global: Number(process.env.TWILIO_INBOUND_GLOBAL_PER_MINUTE ?? 120),
})

/** Outbound, per minute: a burst guard. */
export const outboundBurst = new RateLimit({
  perKey: Number(process.env.TWILIO_OUTBOUND_PER_MINUTE ?? 3),
  windowMs: 60_000,
  global: Number(process.env.TWILIO_OUTBOUND_GLOBAL_PER_MINUTE ?? 10),
})

/** Outbound, per day: the one that bounds the bill. */
export const outboundDaily = new RateLimit({
  perKey: Number(process.env.TWILIO_OUTBOUND_PER_DAY ?? 20),
  windowMs: 24 * 60 * 60_000,
  global: Number(process.env.TWILIO_OUTBOUND_GLOBAL_PER_DAY ?? 100),
})

// --------------------------------------------------------------------------
// Who may be contacted
// --------------------------------------------------------------------------

/**
 * An optional allowlist. Unset means "any valid E.164 number", which is what a
 * business answering real customers needs. Set it while testing, or if this is
 * ever pointed at something that should only talk to known numbers.
 *
 * The owner's own number is always permitted — a transfer would be pointless
 * otherwise — and premium-rate ranges are refused outright, because a runaway
 * loop dialling one is the expensive failure this is here to prevent.
 */
export function destinationAllowed(number, ownerNumber) {
  if (number === ownerNumber) return { ok: true }

  const raw = process.env.TWILIO_ALLOWED_DESTINATIONS?.trim()
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (!list.includes(number)) {
      return { ok: false, reason: 'That number is not on TWILIO_ALLOWED_DESTINATIONS.' }
    }
  }

  // UK 09, US 1-900, and the international premium 979 range.
  if (/^\+449/.test(number) || /^\+1900/.test(number) || /^\+979/.test(number)) {
    return { ok: false, reason: 'Premium-rate numbers are refused.' }
  }
  return { ok: true }
}

// --------------------------------------------------------------------------
// The record
// --------------------------------------------------------------------------

const LOG_FILE = join(homedir(), '.jarvis', 'twilio-log.jsonl')

/**
 * Two audiences, two levels of detail.
 *
 * The file is the business record — who called, when, what was said — and it
 * is local, 0600, and outside the repository. The console is for whoever is
 * watching the terminal, so it gets the shape of the event with the numbers
 * masked and no message body at all: a terminal is shoulder-surfable and ends
 * up pasted into bug reports.
 *
 * Neither ever gets a credential. Everything written is passed through the
 * same redactor first.
 */
export function logEvent(kind, detail = {}) {
  const at = new Date().toISOString()
  const record = { at, kind, ...detail }

  try {
    mkdirSync(join(homedir(), '.jarvis'), { recursive: true, mode: 0o700 })
    appendFileSync(LOG_FILE, redact(JSON.stringify(record)) + '\n', { mode: 0o600 })
  } catch (err) {
    console.error(`[twilio] could not write the log: ${redact(err.message)}`)
  }

  const parts = [kind]
  if (detail.from) parts.push(`from ${maskNumber(detail.from)}`)
  if (detail.to) parts.push(`to ${maskNumber(detail.to)}`)
  if (detail.sid) parts.push(String(detail.sid).slice(0, 6) + '…')
  if (detail.chars !== undefined) parts.push(`${detail.chars} chars`)
  if (detail.status) parts.push(String(detail.status))
  if (detail.reason) parts.push(`(${detail.reason})`)
  console.log(`[twilio] ${redact(parts.join(' · '))}`)
}

export const logFile = LOG_FILE
