/**
 * The customer-communication tools — JARVIS's half of the Twilio gateway.
 *
 * These are the only tools in this project that reach a real person on a real
 * phone, and they are scoped accordingly:
 *
 *   · Four tools, fixed. Not a shell, not a file, not an arbitrary HTTP call.
 *   · Off unless JARVIS_ALLOW_COMMS=1. That switch is separate from
 *     JARVIS_ALLOW_WRITES on purpose — answering customers should not require
 *     turning on phone control, file writes and everything else at once.
 *   · No credentials here at all. The bridge never sees the Twilio auth token;
 *     it asks the gateway on loopback, holding only a local control token.
 *   · Every limit that matters — E.164, allowlists, per-minute and per-day
 *     caps — is enforced in the gateway, past anything the model can reach.
 *     A tool here is a request, not an instruction.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const GATEWAY = `http://127.0.0.1:${Number(process.env.TWILIO_GATEWAY_PORT ?? 8788)}`

/** Names the bridge's gate allows through, and nothing else, ever. */
export const COMMS_TOOLS = new Set([
  'send_customer_sms',
  'place_customer_call',
  'transfer_call_to_owner',
  'send_appointment_reminder',
])

export const commsEnabled = () => process.env.JARVIS_ALLOW_COMMS === '1'

function controlToken() {
  const fromEnv = process.env.JARVIS_COMMS_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    return readFileSync(join(homedir(), '.jarvis', 'twilio-gateway.token'), 'utf8').trim()
  } catch {
    return null
  }
}

const ok = (value) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) },
  ],
})
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

async function callGateway(path, body, method = 'POST') {
  const token = controlToken()
  if (!token) {
    return {
      error:
        'The Twilio gateway has not been started on this machine yet. ' +
        'Start it with: npm run twilio:start',
    }
  }
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { error: data.error ?? `The gateway refused that (${res.status}).` }
    return data
  } catch (err) {
    if (err?.name === 'TimeoutError') return { error: 'The gateway did not respond in time.' }
    return {
      error:
        'The Twilio gateway is not reachable. Start it in another terminal with: ' +
        'npm run twilio:start',
    }
  }
}

/** One shape for every tool, so a refusal always reads the same way. */
const act = async (path, body) => {
  if (!commsEnabled()) {
    return refuse(
      'Customer messaging is switched off. It is enabled by starting the bridge ' +
        'with JARVIS_ALLOW_COMMS=1, which the user has to do deliberately.',
    )
  }
  const result = await callGateway(path, body)
  return result.error ? refuse(result.error) : ok(result)
}

export function commsServer() {
  return createSdkMcpServer({
    name: 'jarvis_comms',
    version: '1.0.0',
    instructions:
      'Customer communications over the local Twilio gateway: text a customer, ' +
      'call them, transfer a live call to the owner, and send appointment ' +
      'reminders. These reach real people on real phones — use them when asked ' +
      'to, never to test, never to explore, and read the message back before ' +
      'sending if there is any doubt about it.',
    alwaysLoad: true,
    tools: [
      tool(
        'send_customer_sms',
        'Send a text message to a customer from the business number. The ' +
          'number must be full international form (E.164), like +447700900123. ' +
          'Say what you are about to send before you send it unless the user ' +
          'has already dictated the exact words.',
        {
          to: z.string().describe('Destination in E.164 form, e.g. +447700900123'),
          body: z.string().min(1).max(480).describe('The message. Kept short — it is a text.'),
        },
        async (args) => act('/api/sms/send', { to: args.to, body: args.body }),
      ),

      tool(
        'place_customer_call',
        'Place an outbound call that speaks a short message when answered. ' +
          'For a call that needs a conversation, ring the owner instead and ' +
          'let them talk — this speaks once and hangs up.',
        {
          to: z.string().describe('Destination in E.164 form.'),
          say: z.string().min(1).max(600).describe('What to say when the call is answered.'),
        },
        async (args) => act('/api/call/start', { to: args.to, say: args.say }),
      ),

      tool(
        'transfer_call_to_owner',
        "Put the customer who is on the line through to the owner's personal " +
          'phone. Takes no destination: the owner\'s number is configured on ' +
          'the gateway and is the only place a transfer can go. Use it when a ' +
          'caller asks for a person.',
        {
          call_sid: z
            .string()
            .optional()
            .describe('Which call, if more than one is up. Defaults to the most recent.'),
        },
        async (args) => act('/api/call/transfer', { call_sid: args.call_sid }),
      ),

      tool(
        'send_appointment_reminder',
        'Text a customer a reminder about an appointment. The wording is ' +
          'assembled by the gateway so every reminder reads the same — supply ' +
          'the facts, not a sentence.',
        {
          to: z.string().describe('Destination in E.164 form.'),
          when: z.string().min(1).describe('When it is, in words: "Tuesday 3 March at 2pm".'),
          name: z.string().optional().describe("The customer's first name, if known."),
          service: z.string().optional().describe('What it is for, e.g. "your boiler service".'),
          location: z.string().optional().describe('Where, if it matters.'),
          contact: z.string().optional().describe('A number to call to change it.'),
        },
        async (args) => act('/api/reminder/send', args),
      ),
    ],
  })
}
