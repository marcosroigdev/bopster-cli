import { createPublic, readNetwork } from './chain.js'
import { connectMcp } from './mcp.js'
import { TxSender } from './sender.js'
import { loadAccount, readOnlyAddress } from './wallet.js'

/**
 * What every command works with. `needKey` loads the signer; without it, the wallet is
 * BOPSTER_WALLET and nothing can be signed.
 */
export async function openSession(config, { needKey, log }) {
  const account = needKey ? loadAccount(config) : null
  const address = account?.address ?? readOnlyAddress(config)
  const pub = createPublic(config)
  const ctx = await readNetwork(pub, config)
  const mcp = await connectMcp(config.mcpUrl)
  const sender = account ? new TxSender({ pub, account, config, log }) : null
  return { config, account, address, pub, ctx, mcp, sender, log, close: () => mcp.close() }
}

export const short = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`
