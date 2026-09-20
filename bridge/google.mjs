/**
 * Gmail and Google Calendar, read-only, over OAuth.
 *
 * JARVIS could already reach your mail by driving Chrome, but that means a
 * browser window open on the right page, a logged-in profile, and a model
 * reading pixels. This talks to Google directly instead: the bridge holds an
 * OAuth token, calls the REST APIs, and hands back structured results. No
 * browser, no scraping, and nothing on screen that has to stay there.
 *
 * What it will not do
 * -------------------
 * Only two scopes are ever requested, both `.readonly`, and there is no code
 * here that sends, deletes, marks, or modifies anything. Google enforces that
 * at the token: even a bug that tried to send mail would be refused by the API,
 * because the token it holds has never been granted the right to.
 *
 * Your password is never involved. The sign-in happens on Google's own pages;
 * the bridge only ever sees the tokens that come back afterwards, and those
 * live in ~/.jarvis (0600), outside this repository, and are never logged.
 *
 * The flow is Authorization Code with PKCE and a loopback redirect, which is
 * what Google specifies for desktop apps: the code that comes back is useless
 * without the verifier this process generated and kept in memory.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// --------------------------------------------------------------------------
// Where things live
// --------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.jarvis')
const TOKEN_FILE = join(CONFIG_DIR, 'google-tokens.json')
const CLIENT_FILE = join(CONFIG_DIR, 'google-client.json')

/**
 * Google's endpoints, overridable so the whole flow can be exercised against a
 * local stand-in. Nothing but a test ever sets these — in normal use every one
 * of them is Google's own address, and the defaults are what ship.
 */
const AUTH_URL =
  process.env.JARVIS_GOOGLE_AUTH_URL ??
  'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL =
  process.env.JARVIS_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token'
const API_BASE =
  process.env.JARVIS_GOOGLE_API_BASE ?? 'https://www.googleapis.com'

/**
 * Read-only, and deliberately the shortest list that answers the questions
 * this is for. `userinfo.email` is here only so the status can name which
 * account is connected — "connected" without saying to what is not a status.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
]

// --------------------------------------------------------------------------
// Secrets discipline
// --------------------------------------------------------------------------

/**
 * Anything that might carry a token gets run through this before it is printed
 * or returned. Tokens reach us inside JSON error bodies more often than you
 * would expect, and a log file is forever.
 */
export function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text
    .replace(/ya29\.[\w.-]+/g, 'ya29.<redacted>')
    .replace(/1\/\/[\w.-]{20,}/g, '<redacted-refresh-token>')
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret|code|code_verifier)"\s*:\s*")[^"]*/g,
      '$1<redacted>',
    )
    .replace(/\b[\w-]{24,}\.apps\.googleusercontent\.com\b/g, '<client-id>')
}

// --------------------------------------------------------------------------
// Client credentials — yours, from your own Google Cloud project
// --------------------------------------------------------------------------

/**
 * The client id and secret identify the *application*, not you, and Google
 * issues them per project. They are read from the environment or from
 * ~/.jarvis/google-client.json — never from this repository, which is why
 * there is no file here to put them in.
 *
 * Accepts the JSON Google's console hands you verbatim (it nests everything
 * under "installed"), because asking someone to reshape a downloaded file by
 * hand is how setup goes wrong.
 */
export function loadClient() {
  const fromEnv = {
    client_id: process.env.GOOGLE_CLIENT_ID?.trim(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
  }
  if (fromEnv.client_id) return fromEnv

  try {
    const raw = JSON.parse(readFileSync(CLIENT_FILE, 'utf8'))
    const c = raw.installed ?? raw.web ?? raw
    if (c?.client_id) {
      return {
        client_id: String(c.client_id).trim(),
        client_secret: c.client_secret ? String(c.client_secret).trim() : undefined,
      }
    }
  } catch {
    // No file, or unreadable — handled by the caller as "not configured".
  }
  return null
}

// --------------------------------------------------------------------------
// The token store
// --------------------------------------------------------------------------

function ensureDir() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

export function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}

function saveTokens(tokens) {
  ensureDir()
  // 0600 at creation rather than after, so there is no window in which the
  // file exists and is readable by anyone else on the machine.
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 1), { mode: 0o600 })
}

export function clearTokens() {
  try {
    rmSync(TOKEN_FILE)
    return true
  } catch {
    return false
  }
}

/** What the outside world is allowed to know: everything except the secrets. */
export function status() {
  const client = loadClient()
  const tokens = loadTokens()
  if (!client) {
    return {
      connected: false,
      configured: false,
      reason:
        'No Google client credentials yet. See the Google section of README.md.',
    }
  }
  if (!tokens?.refresh_token) {
    return {
      connected: false,
      configured: true,
      reason: 'Not connected. Run: npm run google:connect',
    }
  }
  return {
    connected: true,
    configured: true,
    email: tokens.email ?? null,
    scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    // A timestamp, not a token. The access token expiring is routine — it is
    // refreshed automatically — so this is reported as information, not alarm.
    access_expires_at: tokens.expiry ? new Date(tokens.expiry).toISOString() : null,
    connected_at: tokens.connected_at ?? null,
  }
}

// --------------------------------------------------------------------------
// PKCE
// --------------------------------------------------------------------------

const b64url = (buf) => buf.toString('base64url')

function pkce() {
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Constant-time compare so the state check cannot be probed by timing. */
function sameState(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

// --------------------------------------------------------------------------
// Talking to Google
// --------------------------------------------------------------------------

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { error: 'non_json_response', detail: text.slice(0, 200) }
  }
  if (!res.ok) {
    const err = new Error(
      `Google returned ${res.status}: ${redact(body.error_description ?? body.error ?? '')}`,
    )
    err.status = res.status
    err.code = body.error
    throw err
  }
  return body
}

/**
 * A valid access token, refreshed if it is about to expire.
 *
 * The sixty-second margin is there because a token that passes the check and
 * then expires in flight produces a 401 halfway through answering a question,
 * which is a far more confusing failure than refreshing slightly too often.
 */
async function accessToken() {
  const tokens = loadTokens()
  if (!tokens?.refresh_token) {
    throw new Error('Google is not connected. Run: npm run google:connect')
  }
  if (tokens.access_token && tokens.expiry && Date.now() < tokens.expiry - 60_000) {
    return tokens.access_token
  }

  const client = loadClient()
  if (!client) throw new Error('Google client credentials are missing.')

  let refreshed
  try {
    refreshed = await postForm(TOKEN_URL, {
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    })
  } catch (err) {
    // A refresh token is rejected when access has been revoked from the Google
    // account, or it has gone unused for six months. Neither is recoverable
    // here, and keeping the dead token would mean failing this way for ever.
    if (err.code === 'invalid_grant') {
      clearTokens()
      throw new Error(
        'Google access was revoked or expired. Reconnect with: npm run google:connect',
      )
    }
    throw err
  }

  const next = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    // Google returns a new refresh token only sometimes; keep the old one when
    // it does not, or the next refresh has nothing to refresh with.
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
  }
  saveTokens(next)
  return next.access_token
}

async function api(path, params = {}) {
  const token = await accessToken()
  const url = new URL(path, API_BASE)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) v.forEach((one) => url.searchParams.append(k, one))
    else url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const detail = redact(await res.text())
    const err = new Error(`Google API ${res.status}: ${detail.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// --------------------------------------------------------------------------
// The connection flow
// --------------------------------------------------------------------------

/**
 * Runs the sign-in and returns once tokens are stored.
 *
 * The redirect comes back to a loopback server this function starts and stops,
 * on whatever port the OS hands out. Google allows any port on 127.0.0.1 for a
 * Desktop-app client, so nothing has to be registered in advance and the flow
 * never collides with the bridge's own port.
 *
 * @param {(url: string) => void} [onUrl] - told the URL to visit
 */
export function connect(onUrl) {
  const client = loadClient()
  if (!client) {
    return Promise.reject(
      new Error(
        'No Google client credentials. Create a Desktop-app OAuth client in ' +
          'Google Cloud, then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, ' +
          `or save the downloaded JSON as ${CLIENT_FILE}.`,
      ),
    )
  }

  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(32))

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      fn(arg)
    }

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end('Not here.')
        return
      }

      const page = (title, note) =>
        `<!doctype html><meta charset="utf-8"><title>JARVIS</title>` +
        `<body style="background:#04070d;color:#9fd8ff;font:15px ui-monospace,monospace;` +
        `display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
        `<div><h1 style="font-weight:400;letter-spacing:.3em">${title}</h1>` +
        `<p style="color:#5f8fb0">${note}</p></div>`

      // The state check comes first, and a failure does not end the flow.
      //
      // It is what stops a link someone else crafted from planting their
      // authorization code in your session. But this port is open on the
      // machine for as long as the sign-in takes, and anything at all can
      // knock on it — a stale tab, a port scanner, a browser's speculative
      // fetch. Treating a knock as a terminal failure would let any of them
      // cancel a sign-in you are part way through. So: refuse the request,
      // keep waiting for the real one, and let the timeout be the only clock.
      if (!sameState(url.searchParams.get('state'), state)) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(page('REJECTED', 'That response did not match this request.'))
        return
      }

      // Past the state check this really is Google answering us. A refused
      // consent screen comes back the same way a granted one does.
      const failure = url.searchParams.get('error')
      if (failure) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('NOT CONNECTED', 'You can close this tab.'))
        finish(reject, new Error(`Google sign-in was refused: ${failure}`))
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(page('REJECTED', 'No authorization code came back.'))
        finish(reject, new Error('No authorization code in the redirect.'))
        return
      }

      try {
        const port = server.address().port
        const tokens = await postForm(TOKEN_URL, {
          client_id: client.client_id,
          ...(client.client_secret ? { client_secret: client.client_secret } : {}),
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: `http://127.0.0.1:${port}/oauth2callback`,
        })

        if (!tokens.refresh_token) {
          throw new Error(
            'Google did not return a refresh token. Remove JARVIS from ' +
              'myaccount.google.com/permissions and connect again.',
          )
        }

        const record = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          scope: tokens.scope ?? SCOPES.join(' '),
          connected_at: new Date().toISOString(),
        }
        saveTokens(record)

        // Which account this is. Best-effort: a failure here means the status
        // cannot name the address, which is not worth failing a sign-in over.
        try {
          const who = await api('/oauth2/v2/userinfo')
          if (who?.email) saveTokens({ ...record, email: who.email })
        } catch {
          /* status will simply not name the account */
        }

        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('CONNECTED', 'JARVIS can read your mail and calendar. You can close this tab.'))
        finish(resolve, status())
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('NOT CONNECTED', 'Something went wrong. Check the terminal.'))
        finish(reject, err)
      }
    })

    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for Google sign-in.')),
      5 * 60_000,
    )

    server.on('error', (err) => finish(reject, err))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const auth = new URL(AUTH_URL)
      auth.searchParams.set('client_id', client.client_id)
      auth.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/oauth2callback`)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', SCOPES.join(' '))
      auth.searchParams.set('code_challenge', challenge)
      auth.searchParams.set('code_challenge_method', 'S256')
      auth.searchParams.set('state', state)
      // Without offline access there is no refresh token, and JARVIS would
      // need you to sign in again every hour. The forced consent screen is
      // what makes Google issue one on a re-connect as well as the first.
      auth.searchParams.set('access_type', 'offline')
      auth.searchParams.set('prompt', 'consent')
      onUrl?.(auth.toString())
    })
  })
}

// --------------------------------------------------------------------------
// Reading mail
// --------------------------------------------------------------------------

const headerOf = (payload, name) =>
  payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value ?? null

/**
 * Metadata format only: subjects, senders, dates and Gmail's own one-line
 * snippet. Full bodies are not fetched — they are rarely what a spoken answer
 * needs, and every one of them would be a mailbox's worth of private text
 * passing through a language model for no gain.
 */
async function fetchMessages(query, max) {
  const list = await api('/gmail/v1/users/me/messages', {
    q: query,
    maxResults: Math.min(Math.max(max, 1), 25),
  })
  const ids = (list.messages ?? []).map((m) => m.id)
  const messages = await Promise.all(
    ids.map((id) =>
      api(`/gmail/v1/users/me/messages/${id}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      }).catch(() => null),
    ),
  )
  return messages.filter(Boolean).map((m) => ({
    from: headerOf(m.payload, 'From'),
    subject: headerOf(m.payload, 'Subject') ?? '(no subject)',
    date: headerOf(m.payload, 'Date'),
    snippet: m.snippet ?? '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
  }))
}

// --------------------------------------------------------------------------
// Reading the calendar
// --------------------------------------------------------------------------

/**
 * A day boundary in the machine's own timezone.
 *
 * "Tomorrow" has to mean tomorrow where the user is sitting. Building the
 * range from a local Date and letting toISOString convert it is what keeps an
 * evening event from sliding into the next day's agenda.
 */
function localDayRange(dayOffset, days) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() + dayOffset)
  const end = new Date(start)
  end.setDate(end.getDate() + Math.max(days, 1))
  return { timeMin: start.toISOString(), timeMax: end.toISOString() }
}

function offsetFor(day) {
  const named = { today: 0, tomorrow: 1, yesterday: -1 }
  if (day in named) return named[day]
  // An explicit date, counted as a number of days from today so the same
  // local-midnight logic covers it.
  const target = new Date(`${day}T00:00:00`)
  if (Number.isNaN(target.getTime())) return 0
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return Math.round((target - midnight) / 86_400_000)
}

async function fetchEvents(day, days, max) {
  const { timeMin, timeMax } = localDayRange(offsetFor(day), days)
  const res = await api('/calendar/v3/calendars/primary/events', {
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: Math.min(Math.max(max, 1), 50),
  })
  return (res.items ?? []).map((e) => ({
    summary: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    all_day: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location ?? null,
    attendees: (e.attendees ?? []).length || null,
  }))
}

// --------------------------------------------------------------------------
// The tools
// --------------------------------------------------------------------------

const ok = (value) => ({
  content: [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 1),
    },
  ],
})

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * A failure here is nearly always "not connected yet", and that is an
 * instruction rather than an error. Anything else is reported without its
 * details being trusted to stay out of the log.
 */
const explain = (err) => {
  const message = redact(err?.message ?? String(err))
  console.error(`[jarvis] google: ${message}`)
  return refuse(message)
}

export function googleServer() {
  return createSdkMcpServer({
    name: 'google',
    version: '1.0.0',
    instructions:
      "The user's own Gmail and Google Calendar, read-only, over a direct " +
      'API connection — no browser needed. Use these rather than driving ' +
      'Chrome whenever the question is about their mail or their schedule.',
    alwaysLoad: true,
    tools: [
      tool(
        'check_google_connection',
        'Whether JARVIS is connected to the user\'s Google account, and which ' +
          'account it is. Ask this when they want to know if their mail and ' +
          'calendar are linked, or when another Google tool has just refused.',
        {},
        async () => {
          try {
            return ok(status())
          } catch (err) {
            return explain(err)
          }
        },
      ),

      tool(
        'list_recent_email',
        'The most recent messages in the user\'s inbox, newest first, as ' +
          'sender, subject, date and a one-line snippet. This is the tool for ' +
          '"what emails did I get today?" — leave `within_days` at 1 for today ' +
          'and raise it for a wider window. Subjects and snippets only; it ' +
          'never opens the body of a message.',
        {
          within_days: z
            .number()
            .int()
            .min(1)
            .max(30)
            .optional()
            .describe('How far back to look. 1 means today. Defaults to 1.'),
          max: z
            .number()
            .int()
            .min(1)
            .max(25)
            .optional()
            .describe('How many messages at most. Defaults to 10.'),
          unread_only: z
            .boolean()
            .optional()
            .describe('Only messages still marked unread.'),
        },
        async (args) => {
          try {
            const within = args.within_days ?? 1
            const parts = [`newer_than:${within}d`, 'in:inbox']
            if (args.unread_only) parts.push('is:unread')
            const messages = await fetchMessages(parts.join(' '), args.max ?? 10)
            console.log(
              `[jarvis] google: ${messages.length} message(s) over ${within}d`,
            )
            return ok({ window_days: within, count: messages.length, messages })
          } catch (err) {
            return explain(err)
          }
        },
      ),

      tool(
        'search_email',
        'Search the user\'s mail with a Gmail search query and get back ' +
          'sender, subject, date and snippet. Use it for anything narrower ' +
          'than "recent" — a person, a company, a topic. Gmail\'s own syntax ' +
          'works: from:, to:, subject:, newer_than:7d, has:attachment, ' +
          'is:unread, and quoted phrases. For a question like "anything ' +
          'important from Quick Assist customers", search the name as a ' +
          'phrase and read out what comes back.',
        {
          query: z
            .string()
            .min(1)
            .describe('A Gmail search query, e.g. "Quick Assist" newer_than:14d'),
          max: z
            .number()
            .int()
            .min(1)
            .max(25)
            .optional()
            .describe('How many messages at most. Defaults to 10.'),
        },
        async (args) => {
          try {
            const messages = await fetchMessages(args.query, args.max ?? 10)
            // The query can contain the user's own correspondents' names, so
            // the log records that a search happened and how much came back,
            // never what was asked or what was in it.
            console.log(`[jarvis] google: search returned ${messages.length}`)
            return ok({ count: messages.length, messages })
          } catch (err) {
            return explain(err)
          }
        },
      ),

      tool(
        'get_calendar_agenda',
        'The user\'s schedule for a day, in their own timezone, ordered by ' +
          'start time. This is the tool for "what\'s on my calendar tomorrow?" ' +
          '— pass day:"tomorrow". Also takes "today", "yesterday", or a date ' +
          'as YYYY-MM-DD, and `days` to cover a stretch.',
        {
          day: z
            .string()
            .optional()
            .describe('"today" (default), "tomorrow", "yesterday", or YYYY-MM-DD.'),
          days: z
            .number()
            .int()
            .min(1)
            .max(14)
            .optional()
            .describe('How many days from that day. Defaults to 1.'),
          max: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('How many events at most. Defaults to 20.'),
        },
        async (args) => {
          try {
            const day = args.day ?? 'today'
            const events = await fetchEvents(day, args.days ?? 1, args.max ?? 20)
            console.log(`[jarvis] google: ${events.length} event(s) for ${day}`)
            return ok({
              day,
              days: args.days ?? 1,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              count: events.length,
              events,
            })
          } catch (err) {
            return explain(err)
          }
        },
      ),
    ],
  })
}
