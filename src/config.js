import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, isAddress, parseEther, parseGwei } from 'viem'

import { parseAmount } from './amounts.js'
import { UserError } from './errors.js'
import { NETWORKS } from './networks.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Everything the commands need, from the environment (.env is loaded by `npm run bop`). */
export function loadConfig(env = process.env) {
  const networkName = env.BOPSTER_NETWORK || 'base'
  const network = NETWORKS[networkName]
  if (!network) throw new UserError(`BOPSTER_NETWORK="${networkName}" doesn't exist. Use one of: ${Object.keys(NETWORKS).join(', ')}.`)

  const expectedAddress = env.BOPSTER_WALLET?.trim() || null
  if (expectedAddress && !isAddress(expectedAddress)) throw new UserError(`BOPSTER_WALLET="${expectedAddress}" isn't a valid address.`)

  const maxStakePerSide = parseAmount(env.BOPSTER_MAX_STAKE_PER_SIDE || '50', undefined, 'BOPSTER_MAX_STAKE_PER_SIDE')
  const maxStakePerMarket = parseAmount(env.BOPSTER_MAX_STAKE_PER_MARKET || '100', undefined, 'BOPSTER_MAX_STAKE_PER_MARKET')

  return {
    networkName,
    chain: network.chain,
    mcpUrl: env.BOPSTER_MCP_URL || network.mcpUrl,
    rpcUrl: env.BOPSTER_RPC_URL || network.rpcUrl,
    factory: getAddress(network.factory),
    arbitrator: getAddress(network.arbitrator),
    realityTimeoutSeconds: network.realityTimeoutSeconds,
    explorer: network.explorer,
    keyFile: env.BOPSTER_KEY_FILE || join(homedir(), '.bopster', 'private-key'),
    expectedAddress: expectedAddress ? getAddress(expectedAddress) : null,
    maxStakePerSide,
    maxStakePerMarket,
    minEth: parseEther(env.BOPSTER_MIN_ETH || '0.0003'),
    maxFeePerGas: parseGwei(env.BOPSTER_MAX_FEE_GWEI || '1'),
    runsDir: env.BOPSTER_RUNS_DIR || join(REPO_ROOT, 'runs'),
  }
}
