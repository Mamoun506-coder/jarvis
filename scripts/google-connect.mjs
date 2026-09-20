#!/usr/bin/env node
/**
 * Connecting JARVIS to Gmail and Google Calendar.
 *
 *   npm run google:connect      sign in and store the tokens
 *   npm run google:status       say whether it is connected, and as whom
 *   npm run google:disconnect   forget the tokens on this machine
 *
 * The sign-in happens on Google's own pages. This process never sees your
 * password — only the tokens Google hands back afterwards, which are written
 * to ~/.jarvis/google-tokens.json with 0600 permissions and never printed.
 */

import { spawn } from 'node:child_process'
import {
  SCOPES,
  clearTokens,
  connect,
  loadClient,
  status,
} from '../bridge/google.mjs'

const command = process.argv[2] ?? 'connect'

const line = (s = '') => console.log(s)

function printStatus() {
  const s = status()
  line()
  if (s.connected) {
    line(`  CONNECTED${s.email ? ` as ${s.email}` : ''}`)
    line(`  Scopes: ${s.scopes.map((x) => x.split('/').pop()).join(', ')}`)
    if (s.connected_at) line(`  Connected: ${new Date(s.connected_at).toLocaleString()}`)
    line()
    line('  Ask JARVIS: "what emails did I get today?"')
    line('             "what\'s on my calendar tomorrow?"')
  } else {
    line('  NOT CONNECTED')
    line(`  ${s.reason}`)
  }
  line()
}

/** Open the sign-in page for them; printing it is the fallback, not the plan. */
function openInBrowser(url) {
  const opener =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref()
    return true
  } catch {
    return false
  }
}

if (command === 'status') {
  printStatus()
  process.exit(0)
}

if (command === 'disconnect') {
  const had = clearTokens()
  line()
  line(
    had
      ? '  Disconnected. The tokens on this machine are gone.'
      : '  Nothing to disconnect — there were no tokens stored.',
  )
  line()
  line('  To revoke JARVIS\'s access at Google as well, remove it at')
  line('  https://myaccount.google.com/permissions')
  line()
  process.exit(0)
}

if (command !== 'connect') {
  console.error(`Unknown command: ${command} (connect | status | disconnect)`)
  process.exit(1)
}

if (!loadClient()) {
  line()
  line('  JARVIS needs a Google client of your own before it can sign you in.')
  line('  This is free, takes a few minutes, and only has to be done once.')
  line()
  line('  1. Go to https://console.cloud.google.com/apis/credentials')
  line('  2. Create a project if you have none.')
  line('  3. Enable the Gmail API and the Google Calendar API.')
  line('  4. Configure the OAuth consent screen, add yourself as a test user.')
  line('  5. Create credentials -> OAuth client ID -> Desktop app.')
  line('  6. Download the JSON and save it as ~/.jarvis/google-client.json')
  line()
  line('  Then run this again:  npm run google:connect')
  line()
  process.exit(1)
}

line()
line('  Opening Google so you can sign in.')
line(`  JARVIS is asking for read-only access to ${SCOPES.length} things:`)
line('    · Gmail, read only')
line('    · Calendar, read only')
line('    · Your email address, so the status can name the account')
line()

try {
  await connect((url) => {
    if (!openInBrowser(url)) {
      line('  Could not open a browser. Paste this into one yourself:')
    } else {
      line('  If no browser opened, paste this into one:')
    }
    line()
    line(`  ${url}`)
    line()
    line('  Waiting for you to finish signing in...')
  })
  printStatus()
} catch (err) {
  line()
  console.error(`  Not connected: ${err.message}`)
  line()
  process.exit(1)
}
