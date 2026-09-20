/**
 * Configuration for the Twilio gateway.
 *
 * Every secret is read from the environment and nowhere else. There is no
 * config file for credentials, no default value that happens to be a real
 * token, and nothing here is ever written back to disk. If an environment
 * variable is missing the gateway says which one and declines to do the thing
 * that needed it, rather than starting up half-armed.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Its own port. The bridge keeps 8787 and is never touched by any of this. */
export const PORT = Number(process.env.TWILIO_GATEWAY_PORT ?? 8788)

export const config = () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || null,
  authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || null,
  fromNumber: process.env.TWILIO_PHONE_NUMBER?.trim() || null,
  ownerNumber: process.env.OWNER_PHONE_NUMBER?.trim() || null,
  publicBaseUrl: process.env.TWILIO_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null,
})

/**
 * What is ready and what is not — booleans and shapes, never values. This is
 * what /health reports, so it must be safe to show to anyone who can reach it.
 */
export function readiness() {
  const c = config()
  const problems = []
  if (!c.accountSid) problems.push('TWILIO_ACCOUNT_SID is not set')
  else if (!/^AC[0-9a-f]{32}$/i.test(c.accountSid))
    problems.push('TWILIO_ACCOUNT_SID does not look like an account SID')
  if (!c.authToken) problems.push('TWILIO_AUTH_TOKEN is not set')
  if (!c.fromNumber) problems.push('TWILIO_PHONE_NUMBER is not set')
  else if (!isE164(c.fromNumber)) problems.push('TWILIO_PHONE_NUMBER is not E.164')
  if (!c.ownerNumber) problems.push('OWNER_PHONE_NUMBER is not set')
  else if (!isE164(c.ownerNumber)) problems.push('OWNER_PHONE_NUMBER is not E.164')
  if (!c.publicBaseUrl) problems.push('TWILIO_PUBLIC_BASE_URL is not set')
  else if (!/^https:\/\//.test(c.publicBaseUrl))
    problems.push('TWILIO_PUBLIC_BASE_URL must be https — Twilio signs the URL it called')

  // Only required when relay mode is actually switched on. Greeting mode is
  // the default and must keep starting with none of this set.
  if ((process.env.TWILIO_VOICE_MODE ?? 'greeting') === 'relay') {
    const relay = process.env.TWILIO_RELAY_WEBSOCKET_URL?.trim()
    if (!relay) problems.push('TWILIO_VOICE_MODE=relay needs TWILIO_RELAY_WEBSOCKET_URL')
    else if (!/^wss:\/\//.test(relay))
      problems.push('TWILIO_RELAY_WEBSOCKET_URL must be a wss:// address')
  }
  return { ready: problems.length === 0, problems }
}

// --------------------------------------------------------------------------
// E.164
// --------------------------------------------------------------------------

/**
 * E.164: a plus, a country code that cannot start with zero, and up to fifteen
 * digits in total. Deliberately strict — no spaces, dashes, brackets or
 * leading zeros — because a number that reaches Twilio malformed either fails
 * loudly or, worse, dials something that was not meant.
 */
const E164 = /^\+[1-9]\d{7,14}$/

export const isE164 = (value) => typeof value === 'string' && E164.test(value)

/**
 * Accepts what a human or a model is likely to produce and returns strict
 * E.164, or null. Spacing and punctuation are forgiven; a missing country code
 * is not, because guessing one is how a call goes to the wrong country.
 */
export function toE164(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\s()\-.]/g, '')
  return isE164(cleaned) ? cleaned : null
}

/** For logs and for anything a model might repeat out loud. */
export function maskNumber(value) {
  if (typeof value !== 'string' || value.length < 4) return '<number>'
  return `${value.slice(0, 2)}***${value.slice(-4)}`
}

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

/**
 * Run over anything before it is printed. The auth token is the dangerous one:
 * it is the signing key for webhooks and the password for the REST API, and it
 * turns up inside error bodies and Authorization headers without being asked.
 */
export function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const { authToken, accountSid } = config()
  let out = text
  if (authToken) out = out.split(authToken).join('<redacted-auth-token>')
  if (accountSid) out = out.split(accountSid).join('<account-sid>')
  return out
    .replace(/\bAC[0-9a-f]{32}\b/gi, '<account-sid>')
    .replace(/\bSK[0-9a-f]{32}\b/gi, '<api-key-sid>')
    .replace(/(Authorization:\s*\S+)/gi, 'Authorization: <redacted>')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/g, '$1<redacted>')
    .replace(/("(?:auth_token|authToken|password|token)"\s*:\s*")[^"]*/g, '$1<redacted>')
}

// --------------------------------------------------------------------------
// The loopback control token
// --------------------------------------------------------------------------

/**
 * How JARVIS is allowed to ask the gateway to do something.
 *
 * The gateway's control API is bound to loopback, but "loopback" on a laptop
 * means every process on that laptop, including a browser tab's fetch. So the
 * control API also requires a shared token. It is generated here on first run
 * and kept in ~/.jarvis (0600) so the bridge can read it — not in the repo,
 * and not in the environment, where it would be visible to every child process
 * the agent ever spawns.
 */
const TOKEN_FILE = join(homedir(), '.jarvis', 'twilio-gateway.token')

export function controlToken() {
  const fromEnv = process.env.JARVIS_COMMS_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  } catch {
    // Not created yet.
  }
  const token = randomBytes(32).toString('base64url')
  mkdirSync(join(homedir(), '.jarvis'), { recursive: true, mode: 0o700 })
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
  return token
}

/** Constant-time, and length-safe: a plain === leaks the prefix by timing. */
export function sameToken(given, expected) {
  const a = createHash('sha256').update(String(given ?? '')).digest()
  const b = createHash('sha256').update(String(expected ?? '')).digest()
  return timingSafeEqual(a, b)
}
