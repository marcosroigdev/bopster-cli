import { formatEther, formatGwei } from 'viem'

import { usdc } from '../amounts.js'
import { balances, createPublic, readNetwork } from '../chain.js'
import { UserError } from '../errors.js'
import { connectMcp } from '../mcp.js'
import { loadAccount } from '../wallet.js'

/** Config, key, balances and the MCP, without signing or sending anything. */
export async function check(config, { log }) {
  log(`Network: ${config.networkName} (${config.chain.id})`)
  log(`MCP:     ${config.mcpUrl}`)
  log(`RPC:     ${config.rpcUrl}`)

  let address = config.expectedAddress
  try {
    const account = loadAccount(config)
    address = account.address
    log(`Key:     OK, ${config.keyFile}${config.expectedAddress ? ' (matches BOPSTER_WALLET)' : ''}`)
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    log(`Key:     ✗ ${error.message}`)
    if (!address) throw new UserError("No key and no BOPSTER_WALLET: there's no wallet to look at.")
    log('         (only the read-only commands work: check and status)')
  }
  log(`Wallet:  ${address}`)

  const pub = createPublic(config)
  const ctx = await readNetwork(pub, config)
  const { eth, usdc: usdcBalance } = await balances(pub, ctx.token, address)
  log(`Balance: ${formatEther(eth)} ETH${eth < config.minEth ? `  ✗ under BOPSTER_MIN_ETH (${formatEther(config.minEth)})` : ''}`)
  log(`         ${usdc(usdcBalance)}`)
  log(`Factory: ${ctx.factory} (USDC ${ctx.token}, Reality.eth ${ctx.reality})`)
  log(`Caps:    ${usdc(config.maxStakePerSide)} per side, ${usdc(config.maxStakePerMarket)} per market, gas up to ${formatGwei(config.maxFeePerGas)} gwei`)

  const mcp = await connectMcp(config.mcpUrl)
  try {
    const health = await mcp.call('ping_health')
    log(`Backend: ${health.ok ? 'OK' : '✗'} (${health.apiUrl ?? '?'})`)
    const fees = await mcp.call('get_fees')
    if (String(fees.factoryAddress).toLowerCase() !== ctx.factory.toLowerCase()) {
      throw new UserError(`The MCP uses factory ${fees.factoryAddress}, not ${ctx.factory}. Stop here until that's cleared up.`)
    }
    log(`Fees:    ${fees.totalFeePercent}% total (creator ${fees.creatorFeePercent}%, resolver ${fees.resolverRewardPercent}%); the MCP uses the same factory`)
  } finally {
    await mcp.close()
  }
}
