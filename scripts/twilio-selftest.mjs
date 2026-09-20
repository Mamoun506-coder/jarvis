/**
 * The Twilio gateway, exercised end to end against a stand-in Twilio.
 *
 *   npm run twilio:selftest
 *
 * Fake credentials, a mock REST API, and an ephemeral port — nothing here
 * reaches Twilio, costs money, or rings a phone. What it proves is the part
 * that is ours: that a forged webhook is refused, that a real one is accepted,
 * that the limits bite, that E.164 is enforced, that a transfer can only reach
 * the owner, and that no credential reaches the log.
 */
import { createServer } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'

// --- a stand-in Twilio REST API --------------------------------------------

const seen = []

const mockApi = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    seen.push({
      path: req.url,
      auth: req.headers.authorization ?? null,
      form: Object.fromEntries(new URLSearchParams(body)),
    })
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sid: 'SM' + '0'.repeat(30) + '01', status: 'queued', to: '+15558675310' }))
  })
})
await new Promise((r) => mockApi.listen(0, '127.0.0.1', r))

// --- fake credentials, set before anything reads them -----------------------

const AUTH_TOKEN = 'test_auth_token_never_real_0000000000'
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32)
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN
process.env.TWILIO_PHONE_NUMBER = '+15558675309'
process.env.OWNER_PHONE_NUMBER = '+15558675308'
process.env.TWILIO_PUBLIC_BASE_URL = 'https://jarvis.example.test'
process.env.TWILIO_API_BASE = `http://127.0.0.1:${mockApi.address().port}`
process.env.JARVIS_COMMS_TOKEN = 'test-control-token'
process.env.TWILIO_OUTBOUND_PER_MINUTE = '2'
process.env.TWILIO_INBOUND_PER_MINUTE = '3'

const { createGateway } = await import('../twilio/server.mjs')

const { expectedSignature, logFile } = await import('../twilio/guard.mjs')

const { isE164, toE164, maskNumber, redact } = await import('../twilio/config.mjs')

const { greetingTwiml, dialTwiml, relayTwiml, voiceResponse } = await import('../twilio/twiml.mjs')
try { rmSync(logFile) } catch { /* first run */ }

const gateway = createGateway()
await new Promise((r) => gateway.listen(0, '127.0.0.1', r))

const BASE = `http://127.0.0.1:${gateway.address().port}`

let failures = 0

const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures++
}

/** POST a webhook the way Twilio does, optionally with a valid signature. */

const webhook = async (path, params, { sign = true, signature } = {}) => {
  const form = new URLSearchParams(params).toString()
  const sig =
    signature ??
    (sign ? expectedSignature(AUTH_TOKEN, `https://jarvis.example.test${path}`, params) : 'bogus')
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    body: form,
  })
  return { status: res.status, text: await res.text() }
}

const control = async (path, body, { token = 'test-control-token', method = 'POST' } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

console.log('\n  Twilio gateway self-test\n')

// --- 1. E.164 ---------------------------------------------------------------
check('E.164 accepts a full international number', isE164('+447700900123'))
check('E.164 rejects a national number', !isE164('07700900123'))
check('E.164 rejects a leading zero country code', !isE164('+0447700900123'))
check('E.164 rejects letters and punctuation', !isE164('+44 7700 900123') && !isE164('+44-CALL-ME'))
check('E.164 rejects an over-long number', !isE164('+4477009001234567'))
check('formatting is forgiven when normalising', toE164('+44 (7700) 900-123') === '+447700900123')
check('a missing country code is not guessed', toE164('07700900123') === null)
check('numbers are masked for logs', maskNumber('+447700900123') === '+4***0123')

// --- 2. health --------------------------------------------------------------

const health = await fetch(`${BASE}/health`).then((r) => r.json())
check('health reports ready', health.ok === true, JSON.stringify(health.problems))
check('health names the webhook paths', health.webhooks.voice === '/twilio/voice/incoming')
check('health masks the numbers', health.configured.twilio_number === '+1***5309')
check('health never returns a credential',
  !JSON.stringify(health).includes(AUTH_TOKEN) && health.configured.auth_token === true)

// --- 3. signature validation ------------------------------------------------

const good = await webhook('/twilio/sms/incoming', {
  From: '+15558675310', To: '+15558675309', Body: 'hello there', MessageSid: 'SM1',
})
check('a correctly signed SMS webhook is accepted', good.status === 200)
check('the SMS webhook replies with empty TwiML', /<Response\s*\/>/.test(good.text))

const forged = await webhook('/twilio/sms/incoming',
  { From: '+15558675311', To: '+15558675309', Body: 'hi', MessageSid: 'SM2' }, { sign: false })
check('an unsigned webhook is refused with 403', forged.status === 403)

const tampered = await webhook('/twilio/voice/incoming',
  { From: '+15558675312', To: '+15558675309', CallSid: 'CA1' },
  { signature: expectedSignature(AUTH_TOKEN, 'https://jarvis.example.test/twilio/voice/incoming', { From: '+15558675312' }) })
check('a signature over different params is refused', tampered.status === 403)

const wrongPath = await webhook('/twilio/voice/incoming',
  { From: '+15558675313', To: '+15558675309', CallSid: 'CA2' },
  { signature: expectedSignature(AUTH_TOKEN, 'https://jarvis.example.test/twilio/sms/incoming', { From: '+15558675313', To: '+15558675309', CallSid: 'CA2' }) })
check('a signature over a different path is refused', wrongPath.status === 403)

// --- 4. voice ---------------------------------------------------------------

const call = await webhook('/twilio/voice/incoming', { From: '+15558675314', To: '+15558675309', CallSid: 'CA100' })
check('an incoming call gets a greeting', call.status === 200 && /<Gather/.test(call.text))
check('the greeting offers a person', /Press 1/.test(call.text))

const choice = await webhook('/twilio/voice/choice', { From: '+15558675314', CallSid: 'CA100', Digits: '1' })
check('pressing 1 dials the owner', /<Dial/.test(choice.text) && choice.text.includes('+15558675308'))
check('the transfer uses the business number as caller ID', choice.text.includes('callerId="+15558675309"'))
check('TwiML escapes hostile input',
  !greetingTwiml({ greeting: '</Say><Hangup/><Say>pwned' }).includes('<Hangup/><Say>pwned'))
check('dial TwiML escapes its destination', dialTwiml({ to: '+1"><Dial>', callerId: '+1' }).includes('&quot;'))

// --- 5. ConversationRelay is structured but not switched on -----------------
check('voiceResponse defaults to the greeting', /<Gather/.test(voiceResponse('greeting', {})))

let relayErr = null
try { relayTwiml({}) } catch (e) { relayErr = e.message }
check('relay mode refuses to run unconfigured', /not configured/i.test(relayErr ?? ''))
check('relay TwiML has the right shape when it is configured',
  /<Connect><ConversationRelay url="wss:\/\/x.test"/.test(relayTwiml({ relayWebSocketUrl: 'wss://x.test' })))

// --- 6. inbound rate limiting -----------------------------------------------

let limited = null
for (let i = 0; i < 6; i++) {
  const r = await webhook('/twilio/sms/incoming',
    { From: '+15558675399', To: '+15558675309', Body: `flood ${i}`, MessageSid: `SMF${i}` })
  if (r.status === 429) { limited = i; break }
}
check('a flood from one number is rate limited', limited !== null, `stopped at message ${limited}`)

// --- 7. the control API -----------------------------------------------------

const noToken = await control('/api/sms/send', { to: '+15558675310', body: 'x' }, { token: null })
check('the control API refuses a request with no token', noToken.status === 401)

const badToken = await control('/api/sms/send', { to: '+15558675310', body: 'x' }, { token: 'wrong' })
check('the control API refuses a wrong token', badToken.status === 401)

const badNumber = await control('/api/sms/send', { to: '07700900123', body: 'x' })
check('the control API refuses a non-E.164 destination', badNumber.status === 400)

const premium = await control('/api/sms/send', { to: '+449001234567', body: 'x' })
check('premium-rate numbers are refused', premium.status === 403, JSON.stringify(premium.body))

const sent = await control('/api/sms/send', { to: '+15558675310', body: 'Your appointment is confirmed.' })
check('an SMS is sent', sent.status === 200 && sent.body.ok === true, JSON.stringify(sent.body))
check('the REST call carried Basic auth', (seen.at(-1)?.auth ?? '').startsWith('Basic '))
check('the REST call used the business number as From', seen.at(-1)?.form.From === '+15558675309')

const long = await control('/api/sms/send', { to: '+15558675315', body: 'x'.repeat(600) })
check('an over-long message is refused before it is sent', long.status === 400)

// --- 8. outbound rate limiting (cap set to 2/min above) ---------------------

const burst = []
for (let i = 0; i < 4; i++) burst.push(await control('/api/sms/send', { to: '+15558675320', body: `n${i}` }))
check('outbound messages to one number are capped', burst.some((r) => r.status === 429),
  burst.map((r) => r.status).join(','))

// --- 9. calls and transfer --------------------------------------------------

const placed = await control('/api/call/start', { to: '+15558675330', say: 'This is a test call.' })
check('an outbound call is placed', placed.status === 200, JSON.stringify(placed.body))
check('the call carried inline TwiML', /<Say/.test(seen.at(-1)?.form.Twiml ?? ''))

const active = await control('/api/calls/active', null, { method: 'GET' })
check('the active call from the webhook is tracked', active.body.count >= 1)
check('active calls are listed with masked numbers', /\*\*\*/.test(JSON.stringify(active.body.calls)))

const transferred = await control('/api/call/transfer', { call_sid: 'CA100' })
check('a live call transfers to the owner', transferred.status === 200, JSON.stringify(transferred.body))
check('the transfer dials the owner and nobody else',
  (seen.at(-1)?.form.Twiml ?? '').includes('+15558675308'))
check('the transfer ignores any destination the caller supplies',
  !(seen.at(-1)?.form.Twiml ?? '').includes('+19999999999'))

const attempted = await control('/api/call/transfer', { call_sid: 'CA100', to: '+19999999999' })
check('transferring an already-transferred call is refused or re-routed to the owner',
  attempted.status !== 200 || !(seen.at(-1)?.form.Twiml ?? '').includes('+19999999999'))

// --- 10. appointment reminders ----------------------------------------------

const reminder = await control('/api/reminder/send', {
  to: '+15558675340', name: 'Maria', when: 'Tuesday 3 March at 2pm',
  service: 'your boiler service', contact: '+15558675309',
})
check('an appointment reminder is sent', reminder.status === 200, JSON.stringify(reminder.body))

const reminderBody = seen.at(-1)?.form.Body ?? ''
check('the reminder reads like a reminder',
  /Hi Maria/.test(reminderBody) && /Tuesday 3 March at 2pm/.test(reminderBody), reminderBody)

// --- 11. secrets stay out of the record -------------------------------------

const logText = readFileSync(logFile, 'utf8')
check('the log recorded the traffic', logText.split('\n').filter(Boolean).length > 3)
check('the log contains the auth token nowhere', !logText.includes(AUTH_TOKEN))
check('the log contains the account SID nowhere', !logText.includes(process.env.TWILIO_ACCOUNT_SID))
check('the log has no Authorization header in it', !/Basic [A-Za-z0-9+/=]{10,}/.test(logText))
check('redact removes an auth token from arbitrary text',
  !redact(`token=${AUTH_TOKEN} end`).includes(AUTH_TOKEN))
check('redact removes an account SID', redact('AC' + 'b'.repeat(32)) === '<account-sid>')
check('the log did record the message text as a business record',
  logText.includes('Your appointment is confirmed.'))

// --- 12. the bridge-side gate ------------------------------------------------

const { COMMS_TOOLS, commsEnabled } = await import('../bridge/comms.mjs')
delete process.env.JARVIS_ALLOW_COMMS
check('comms are off unless explicitly enabled', commsEnabled() === false)
process.env.JARVIS_ALLOW_COMMS = '1'
check('JARVIS_ALLOW_COMMS=1 enables them', commsEnabled() === true)
check('the tool allowlist is exactly four tools', COMMS_TOOLS.size === 4)
check('the allowlist does not include a shell or file tool',
  ![...COMMS_TOOLS].some((t) => /bash|shell|exec|write|file/i.test(t)))

const bridgeSource = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8')
check('the bridge gates comms on its own switch, not ALLOW_WRITES',
  /server === 'jarvis_comms'[\s\S]{0,200}commsEnabled\(\)/.test(bridgeSource))
check('the comms module holds no Twilio credentials',
  !readFileSync(new URL('../bridge/comms.mjs', import.meta.url), 'utf8').includes('TWILIO_AUTH_TOKEN'))

// --- 13. nothing hardcoded in the source ------------------------------------

for (const file of ['../twilio/config.mjs', '../twilio/client.mjs', '../twilio/server.mjs', '../twilio/guard.mjs']) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
  check(`${file.split('/').pop()} contains no real-looking credential`,
    !/AC[0-9a-f]{32}/.test(src) && !/\b\+1\d{10}\b/.test(src))
}

gateway.close()
mockApi.close()

console.log(`\n  ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
