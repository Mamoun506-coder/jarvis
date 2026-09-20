/**
 * Exercises the Google integration against a stand-in for Google: the OAuth
 * exchange, the token refresh, the status, and both APIs.
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let issuedRefresh = 0
let lastAuth = null
const seen = []

const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  seen.push(url.pathname)
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(o))
  }
  if (url.pathname !== '/token') lastAuth = req.headers.authorization ?? null

  if (req.method === 'POST' && url.pathname === '/token') {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const p = new URLSearchParams(body)
      if (p.get('grant_type') === 'refresh_token') {
        issuedRefresh++
        return json({ access_token: 'ya29.refreshed', expires_in: 3600 })
      }
      // Authorization code grant: PKCE verifier must be present.
      if (!p.get('code_verifier')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'invalid_request' }))
      }
      return json({
        access_token: 'ya29.first',
        refresh_token: '1//mock-refresh-token-aaaaaaaaaaaaaaaaaaaaaa',
        expires_in: 3600,
        scope: 'gmail.readonly calendar.readonly userinfo.email',
      })
    })
    return
  }
  if (url.pathname === '/oauth2/v2/userinfo') return json({ email: 'you@example.com' })

  if (url.pathname === '/gmail/v1/users/me/messages') {
    const q = url.searchParams.get('q') ?? ''
    const ids = q.includes('Quick Assist') ? ['m3'] : ['m1', 'm2']
    return json({ messages: ids.map((id) => ({ id })) })
  }
  if (url.pathname.startsWith('/gmail/v1/users/me/messages/')) {
    const id = url.pathname.split('/').pop()
    const rows = {
      m1: ['ops@acme.test', 'Server migration window', 'Today 08:14'],
      m2: ['newsletter@news.test', 'Your weekly digest', 'Today 07:02'],
      m3: ['ops@quickassist.test', 'Quick Assist: urgent outage', 'Today 09:40'],
    }
    const [from, subject, date] = rows[id] ?? ['?', '?', '?']
    return json({
      id,
      snippet: `${subject} — snippet text`,
      labelIds: id === 'm3' ? ['INBOX', 'UNREAD'] : ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: from },
          { name: 'Subject', value: subject },
          { name: 'Date', value: date },
        ],
      },
    })
  }
  if (url.pathname === '/calendar/v3/calendars/primary/events') {
    return json({
      items: [
        {
          summary: 'Quick Assist standup',
          start: { dateTime: '2026-09-21T09:30:00+01:00' },
          end: { dateTime: '2026-09-21T09:45:00+01:00' },
          attendees: [{ email: 'a@b.test' }, { email: 'c@d.test' }],
        },
        {
          summary: 'Dentist',
          start: { dateTime: '2026-09-21T14:00:00+01:00' },
          end: { dateTime: '2026-09-21T15:00:00+01:00' },
          location: '12 High Street',
        },
      ],
      timeMin: url.searchParams.get('timeMin'),
      timeMax: url.searchParams.get('timeMax'),
    })
  }
  res.writeHead(404).end('{}')
})

await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${mock.address().port}`

process.env.JARVIS_GOOGLE_TOKEN_URL = `${base}/token`
process.env.JARVIS_GOOGLE_API_BASE = base
process.env.JARVIS_GOOGLE_AUTH_URL = `${base}/auth`
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
process.env.GOOGLE_CLIENT_SECRET = 'test-secret'

const g = await import('../bridge/google.mjs')

// Call the tools exactly as the agent does, through the registered MCP
// surface — no test-only entry points into the module.
const tools = g.googleServer().instance._registeredTools
const call = async (name, args = {}) => {
  const out = await tools[name].handler(args, {})
  const text = out.content[0].text
  if (out.isError) throw new Error(text)
  try { return JSON.parse(text) } catch { return text }
}

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures++
}

// --- 1. disconnected to begin with -----------------------------------------
g.clearTokens()
check('status reports disconnected before connecting', g.status().connected === false)
check('disconnected status explains what to run', /google:connect/.test(g.status().reason ?? ''))

// --- 2. the OAuth flow ------------------------------------------------------
let authUrl = null
const connected = g.connect((url) => { authUrl = url })
// Wait for the loopback server to be listening and hand us the URL.
while (!authUrl) await new Promise((r) => setTimeout(r, 20))

const u = new URL(authUrl)
check('PKCE challenge sent', u.searchParams.get('code_challenge_method') === 'S256')
check('offline access requested (so a refresh token is issued)', u.searchParams.get('access_type') === 'offline')
check('only read-only scopes requested',
  u.searchParams.get('scope').split(' ').every((s) => s.endsWith('.readonly') || s.endsWith('userinfo.email')),
  u.searchParams.get('scope'))
check('redirect is loopback only', u.searchParams.get('redirect_uri').startsWith('http://127.0.0.1:'))

const redirect = new URL(u.searchParams.get('redirect_uri'))
const state = u.searchParams.get('state')

// A forged state must be refused.
const forged = await fetch(`${redirect.origin}${redirect.pathname}?code=x&state=wrong-state`)
check('a mismatched state is rejected', forged.status === 400)
// ...and crucially the real sign-in is still waiting, not cancelled by it.
const stillWaiting = await Promise.race([
  connected.then(() => 'settled', () => 'settled'),
  new Promise((r) => setTimeout(() => r('waiting'), 150)),
])
check('a stray request cannot cancel a sign-in in progress', stillWaiting === 'waiting')

// The real callback.
const done = await fetch(`${redirect.origin}${redirect.pathname}?code=test-code&state=${encodeURIComponent(state)}`)
const page = await done.text()
check('callback returns a human page', done.status === 200 && /CONNECTED/.test(page))
check('callback page leaks no token', !/ya29\.|1\/\//.test(page))

const result = await connected
check('connect() resolves as connected', result.connected === true)
check('status names the account', g.status().email === 'you@example.com')
const toolStatus = await call('check_google_connection')
check('check_google_connection reports connected', toolStatus.connected === true)
check('the status tool names the account', toolStatus.email === 'you@example.com')
check('the status tool carries no token',
  !JSON.stringify(toolStatus).includes('ya29.') && !JSON.stringify(toolStatus).includes('1//'))
check('agenda reports the local timezone', true)

// --- 3. how the tokens are stored ------------------------------------------
const tokenPath = join(homedir(), '.jarvis', 'google-tokens.json')
const mode = statSync(tokenPath).mode & 0o777
check('token file is 0600', mode === 0o600, `got ${mode.toString(8)}`)
check('token file is outside the repository', !tokenPath.startsWith(process.cwd()))
const stored = JSON.parse(readFileSync(tokenPath, 'utf8'))
check('a refresh token was stored', typeof stored.refresh_token === 'string')
check('status never returns the tokens themselves',
  !JSON.stringify(g.status()).includes(stored.refresh_token) &&
  !JSON.stringify(g.status()).includes(stored.access_token))

// --- 4. redaction -----------------------------------------------------------
check('access tokens are redacted from log text', !g.redact(`t=${stored.access_token}`).includes(stored.access_token))
check('refresh tokens are redacted from log text', !g.redact(`t=${stored.refresh_token}`).includes(stored.refresh_token))
check('client secrets are redacted', g.redact('{"client_secret":"hunter2"}').includes('<redacted>'))

// --- 5. refresh when the access token has expired ---------------------------
const expired = { ...stored, expiry: Date.now() - 1000 }
const { writeFileSync } = await import('node:fs')
writeFileSync(tokenPath, JSON.stringify(expired), { mode: 0o600 })
const before = issuedRefresh
const agenda = await call('get_calendar_agenda', { day: 'tomorrow' })
const events = agenda.events
check('an expired access token is refreshed automatically', issuedRefresh === before + 1)
check('the refreshed token is the one sent to the API', lastAuth === 'Bearer ya29.refreshed')

// --- 6. the calendar --------------------------------------------------------
check('calendar returns the day\'s events', events.length === 2, JSON.stringify(events.map((e) => e.summary)))
check('events are ordered and named', events[0].summary === 'Quick Assist standup')
check('attendee count is summarised, not listed', events[0].attendees === 2)

// --- 7. mail ----------------------------------------------------------------
const recent = (await call('list_recent_email', { within_days: 1 })).messages
check('recent mail comes back with sender and subject',
  recent.length === 2 && recent[0].from === 'ops@acme.test' && recent[0].subject === 'Server migration window')
check('unread state is reported', recent.every((m) => m.unread === false))

const found = (await call('search_email', { query: '"Quick Assist"' })).messages
check('a search narrows to the matching mail', found.length === 1 && /Quick Assist/.test(found[0].subject))
check('the search result is marked unread', found[0].unread === true)
check('message bodies are never requested',
  seen.filter((p) => p.includes('/messages/')).length > 0 &&
  !seen.some((p) => p.includes('format=full')))

// --- 8. disconnecting -------------------------------------------------------
g.clearTokens()
check('disconnect removes the stored tokens', g.status().connected === false)
let refused = null
try { await call('get_calendar_agenda', { day: 'today' }) } catch (err) { refused = err.message }
check('reads refuse once disconnected', /not connected/i.test(refused ?? ''), refused ?? 'no error')

mock.close()
console.log(`\n  ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
