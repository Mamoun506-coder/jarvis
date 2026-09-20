/**
 * The Twilio REST API, over plain fetch.
 *
 * No SDK. This needs four calls, all of them form-encoded POSTs to documented
 * URLs, and a dependency that ships its own HTTP stack and credential handling
 * is a larger surface than the thing it would save.
 *
 * Credentials are read at call time from the environment, never captured into
 * a module-level variable, so a gateway started without them fails at the
 * point of use with a message that says which variable is missing.
 */

import { config, redact } from './config.mjs'

const API_BASE = process.env.TWILIO_API_BASE ?? 'https://api.twilio.com'

function auth() {
  const { accountSid, authToken } = config()
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio credentials are missing — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
    )
  }
  return {
    accountSid,
    header: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
  }
}

async function post(path, form) {
  const { accountSid, header } = auth()
  const url = `${API_BASE}/2010-04-01/Accounts/${accountSid}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: header,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  })

  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { message: text.slice(0, 200) }
  }

  if (!res.ok) {
    // Twilio's error bodies are helpful and occasionally echo the request, so
    // they go through the redactor before they are allowed anywhere near a log.
    const err = new Error(
      `Twilio ${res.status}: ${redact(body.message ?? 'request failed')}` +
        (body.code ? ` (code ${body.code})` : ''),
    )
    err.status = res.status
    err.twilioCode = body.code
    throw err
  }
  return body
}

/** Send an SMS. Returns the message SID and status — never the body back. */
export async function sendSms({ to, body, statusCallback }) {
  const { fromNumber } = config()
  const message = await post('/Messages.json', {
    To: to,
    From: fromNumber,
    Body: body,
    ...(statusCallback ? { StatusCallback: statusCallback } : {}),
  })
  return { sid: message.sid, status: message.status, to: message.to }
}

/**
 * Place an outbound call.
 *
 * Twilio needs to know what to say once it answers, and it gets that either
 * from a URL it fetches or from inline TwiML. Inline is used here so the
 * instruction for a given call cannot be changed by anything that can reach
 * the gateway's public URL between placing the call and it connecting.
 */
export async function placeCall({ to, twiml, statusCallback }) {
  const { fromNumber } = config()
  const call = await post('/Calls.json', {
    To: to,
    From: fromNumber,
    Twiml: twiml,
    ...(statusCallback
      ? { StatusCallback: statusCallback, StatusCallbackEvent: 'completed' }
      : {}),
  })
  return { sid: call.sid, status: call.status, to: call.to }
}

/**
 * Redirect a call that is already up — this is the transfer.
 *
 * POSTing new TwiML to a live call replaces what it is doing, so a caller
 * listening to the greeting is put through mid-sentence. The call SID is the
 * one from the inbound webhook, which is why the gateway keeps track of them.
 */
export async function redirectCall({ callSid, twiml }) {
  const call = await post(`/Calls/${encodeURIComponent(callSid)}.json`, { Twiml: twiml })
  return { sid: call.sid, status: call.status }
}

/** Used by the self-test to confirm credentials reach the wire correctly. */
export const apiBase = API_BASE
