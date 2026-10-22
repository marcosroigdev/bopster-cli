import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { UserError } from './errors.js'
import { checkLoginMessage } from './guard.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class McpToolError extends UserError {
  constructor(tool, text) {
    super(`${tool}: ${text}`)
    this.tool = tool
    this.text = text
  }
}

export async function connectMcp(url) {
  const client = new Client({ name: 'bopster-cli', version: '0.1.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  } catch (error) {
    throw new UserError(`Can't reach the MCP at ${url}: ${error.message}`)
  }

  /** Calls a tool and returns its JSON. A tool error becomes a McpToolError with the MCP's own text. */
  async function call(name, args = {}) {
    const res = await client.callTool({ name, arguments: args })
    const text = res.content?.find((c) => c.type === 'text')?.text ?? ''
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    if (res.isError) throw new McpToolError(name, typeof body === 'string' ? body : JSON.stringify(body))
    return body
  }

  /** For steps that wait on the chain or the backend to catch up. Only tool errors are retried. */
  async function callRetrying(name, args, { attempts, delayMs, log }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(name, args)
      } catch (error) {
        if (!(error instanceof McpToolError) || attempt >= attempts) throw error
        log(`      ${name}: not yet (${error.text.slice(0, 140)}); trying again in ${delayMs / 1000} s`)
        await sleep(delayMs)
      }
    }
  }

  return { call, callRetrying, close: () => client.close().catch(() => {}) }
}

/**
 * A one-time login for the wallet: the MCP's message, checked, then signed. When the MCP's
 * per-client limit says to wait, waits and asks again.
 */
export async function login(mcp, account, log) {
  for (let attempt = 1; ; attempt++) {
    try {
      const message = await mcp.call('get_login_message', { wallet: account.address })
      checkLoginMessage(message, account.address)
      return { nonce: message.nonce, signature: await account.signMessage({ message: message.message }) }
    } catch (error) {
      const wait = /Wait (\d+) seconds/.exec(error.message)
      if (!wait || attempt >= 4) throw error
      log(`      MCP login limit: waiting ${wait[1]} s`)
      await sleep(Math.min(Number(wait[1]) + 1, 120) * 1000)
    }
  }
}
