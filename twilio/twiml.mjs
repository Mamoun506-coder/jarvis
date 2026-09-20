/**
 * The TwiML this gateway speaks.
 *
 * Kept in one place and built from data rather than string-concatenated at the
 * call site, because TwiML is XML that Twilio executes: an unescaped quote in
 * a customer's name is a broken call, and an unescaped tag is worse.
 *
 * Structured for what comes next. `voiceResponse()` switches on a mode, and
 * today there are two — `greeting`, which answers and offers a transfer, and
 * `relay`, the placeholder for Twilio ConversationRelay, which will stream the
 * call to a live AI voice. Adding that later means filling in one branch and
 * pointing it at a WebSocket URL; nothing else in the gateway has to move.
 */

/** XML escaping, applied to every interpolated value without exception. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const doc = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`

/**
 * The greeting an incoming caller hears.
 *
 * `<Gather>` rather than a bare `<Say>` so the caller has somewhere to go: one
 * keypress reaches a human. The action URL is relative, which keeps it correct
 * whichever host Twilio was configured with.
 */
export function greetingTwiml({ greeting, transferPrompt } = {}) {
  const hello =
    greeting ??
    'Thank you for calling. This line is answered by an automated assistant.'
  const prompt = transferPrompt ?? 'Press 1 at any time to be put through to a person.'
  return doc(
    `<Gather numDigits="1" action="/twilio/voice/choice" method="POST" timeout="8">` +
      `<Say voice="Polly.Brian">${esc(hello)} ${esc(prompt)}</Say>` +
      `</Gather>` +
      `<Say voice="Polly.Brian">Nobody pressed anything, so I will say goodbye.</Say>` +
      `<Hangup/>`,
  )
}

/**
 * Connecting a caller to a person.
 *
 * `callerId` is the Twilio number, not the caller's — using the caller's would
 * be spoofing someone else's line, which carriers increasingly refuse and
 * which is illegal in several places besides.
 */
export function dialTwiml({ to, callerId, whisper }) {
  const say = whisper
    ? `<Say voice="Polly.Brian">${esc(whisper)}</Say>`
    : ''
  return doc(
    say +
      `<Dial callerId="${esc(callerId)}" timeout="25" answerOnBridge="true">` +
      `<Number>${esc(to)}</Number>` +
      `</Dial>` +
      `<Say voice="Polly.Brian">That line did not answer. Goodbye.</Say>` +
      `<Hangup/>`,
  )
}

export function sayTwiml(text) {
  return doc(`<Say voice="Polly.Brian">${esc(text)}</Say><Hangup/>`)
}

export function rejectTwiml(reason = 'busy') {
  return doc(`<Reject reason="${esc(reason)}"/>`)
}

/**
 * Where live AI voice will go.
 *
 * ConversationRelay hands the audio to a WebSocket and speaks the text sent
 * back, which is what would let JARVIS hold the call himself rather than read
 * a script. It is deliberately not switched on: it needs a public WebSocket
 * endpoint and a conversation loop with its own guardrails, and shipping half
 * of that would mean a live microphone into an agent with no gate in front of
 * it. The shape is here so the next step is additive.
 */
export function relayTwiml({ relayWebSocketUrl, welcome }) {
  if (!relayWebSocketUrl) {
    throw new Error('ConversationRelay is not configured (no WebSocket URL).')
  }
  return doc(
    `<Connect>` +
      `<ConversationRelay url="${esc(relayWebSocketUrl)}"` +
      ` welcomeGreeting="${esc(welcome ?? 'One moment.')}"` +
      ` ttsProvider="Amazon" voice="Polly.Brian"/>` +
      `</Connect>`,
  )
}

/**
 * The one entry point the webhook uses, so the choice of mode is made in a
 * single place and a future mode cannot be half-adopted.
 */
export function voiceResponse(mode, options = {}) {
  switch (mode) {
    case 'relay':
      return relayTwiml(options)
    case 'greeting':
    default:
      return greetingTwiml(options)
  }
}

export const CONTENT_TYPE = 'text/xml; charset=utf-8'
