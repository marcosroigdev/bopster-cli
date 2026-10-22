import { createPublicClient, getAddress, http, parseEventLogs } from 'viem'

import { erc20Abi, factoryAbi, marketAbi, realityAbi } from './abis.js'
import { USDC_DECIMALS } from './amounts.js'
import { UserError } from './errors.js'

const MULTICALL_CHUNK = 300

/** Reads only: transactions are signed by the local account and broadcast raw (see sender.js). */
export function createPublic(config) {
  return createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl, { retryCount: 3, timeout: 20_000 }),
    pollingInterval: 2_000,
  })
}

/** The chain, and the USDC and Reality.eth addresses the factory itself uses. */
export async function readNetwork(pub, config) {
  const chainId = await pub.getChainId()
  if (chainId !== config.chain.id) {
    throw new UserError(`The RPC ${config.rpcUrl} is on chain ${chainId}, not ${config.chain.name} (${config.chain.id}).`)
  }
  const [token, reality] = await Promise.all([
    pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'token' }),
    pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'reality' }),
  ])
  const decimals = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
  if (Number(decimals) !== USDC_DECIMALS) throw new UserError(`The factory's token has ${decimals} decimals, not ${USDC_DECIMALS}.`)
  return {
    factory: config.factory,
    token: getAddress(token),
    reality: getAddress(reality),
    arbitrator: config.arbitrator,
    realityTimeoutSeconds: config.realityTimeoutSeconds,
    knownMarkets: new Set(),
  }
}

export async function balances(pub, token, address) {
  const [eth, usdc] = await Promise.all([
    pub.getBalance({ address }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ])
  return { eth, usdc }
}

async function multicall(pub, contracts) {
  const results = []
  for (let i = 0; i < contracts.length; i += MULTICALL_CHUNK) {
    results.push(...(await pub.multicall({ allowFailure: false, contracts: contracts.slice(i, i + MULTICALL_CHUNK) })))
  }
  return results
}

/** Every market the factory deployed, from its own registry. Fills ctx.knownMarkets. */
export async function loadFactoryMarkets(pub, ctx) {
  const count = await pub.readContract({ address: ctx.factory, abi: factoryAbi, functionName: 'marketsCount' })
  const markets = await multicall(
    pub,
    Array.from({ length: Number(count) }, (_, i) => ({
      address: ctx.factory,
      abi: factoryAbi,
      functionName: 'allMarkets',
      args: [BigInt(i)],
    })),
  )
  for (const market of markets) ctx.knownMarkets.add(market.toLowerCase())
  return markets.map((m) => getAddress(m))
}

/** The wallet's YES/NO stake and claimed flag in each market, read in one multicall. */
export async function positionsOf(pub, markets, wallet) {
  const reads = markets.flatMap((address) => [
    { address, abi: marketAbi, functionName: 'yesPosition', args: [wallet] },
    { address, abi: marketAbi, functionName: 'noPosition', args: [wallet] },
    { address, abi: marketAbi, functionName: 'claimed', args: [wallet] },
  ])
  const values = await multicall(pub, reads)
  return markets.map((market, i) => ({ market, yes: values[i * 3], no: values[i * 3 + 1], claimed: values[i * 3 + 2] }))
}

/** The Reality.eth question a confirmed askQuestion created. */
export function questionIdIn(receipt, reality) {
  const log = parseEventLogs({ abi: realityAbi, eventName: 'LogNewQuestion', logs: receipt.logs }).find(
    (l) => l.address.toLowerCase() === reality.toLowerCase(),
  )
  if (!log) throw new UserError(`Transaction ${receipt.transactionHash} didn't create a question on Reality.eth.`)
  return log.args.question_id
}

/** The market a confirmed createMarket deployed, from the factory's own event. */
export function marketCreatedIn(receipt, factory) {
  const log = parseEventLogs({ abi: factoryAbi, eventName: 'MarketCreated', logs: receipt.logs }).find(
    (l) => l.address.toLowerCase() === factory.toLowerCase(),
  )
  if (!log) throw new UserError(`Transaction ${receipt.transactionHash} didn't create a market on the factory.`)
  return getAddress(log.args.market)
}
