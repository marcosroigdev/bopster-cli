import { formatEther, formatUnits, getAddress, isAddress } from 'viem'

import { parseAmount, usdc, USDC_DECIMALS } from '../amounts.js'
import { balances, loadFactoryMarkets, positionsOf } from '../chain.js'
import { UserError } from '../errors.js'
import { checkPosition } from '../guard.js'
import { confirm } from '../prompt.js'
import { openSession } from '../session.js'

/** Tells the backend about a confirmed transaction. A failure is only logged; the indexer catches up. */
export async function syncMarket(s, market, txHash) {
  try {
    await s.mcp.call('sync_market', { market, tx_hash: txHash, wallet: s.address })
  } catch (error) {
    s.log(`      (sync_market: ${error.message.slice(0, 120)}; the backend's indexer will pick it up)`)
  }
}

/** approve + positionYes/positionNo as the MCP prepared them, checked first. */
export async function placePosition(s, { market, side, amount, onHash }) {
  const prepared = await s.mcp.call('prepare_position', {
    market,
    side,
    amount: formatUnits(amount, USDC_DECIMALS),
    wallet: s.account.address,
  })
  checkPosition(prepared.transactions, { market, side, amount }, s.ctx)
  await s.sender.send(prepared.transactions[0], `approve ${usdc(amount)} for ${side}`)
  const receipt = await s.sender.send(prepared.transactions[1], `${side} position, ${usdc(amount)}`, onHash)
  await syncMarket(s, market, receipt.transactionHash)
  return receipt
}

/** `position <market> <YES|NO> <amount>`: one position on an existing market. */
export async function position(config, args, { yes, log }) {
  const [marketArg, sideArg, amountArg] = args
  if (!marketArg || !sideArg || !amountArg) throw new UserError('Usage: position <market 0x...> <YES|NO> <amount in USDC> [--yes]')
  if (!isAddress(marketArg)) throw new UserError(`${marketArg} isn't an address.`)
  const market = getAddress(marketArg)
  const side = sideArg.toUpperCase()
  if (side !== 'YES' && side !== 'NO') throw new UserError('The side must be YES or NO.')
  const amount = parseAmount(amountArg)
  if (amount === 0n) throw new UserError('The amount must be more than zero.')
  if (amount > config.maxStakePerSide) throw new UserError(`${usdc(amount)} is over BOPSTER_MAX_STAKE_PER_SIDE (${usdc(config.maxStakePerSide)}).`)

  const s = await openSession(config, { needKey: true, log })
  try {
    await loadFactoryMarkets(s.pub, s.ctx)
    if (!s.ctx.knownMarkets.has(market.toLowerCase())) throw new UserError(`${market} isn't a market from the Bopster factory.`)

    const [held] = await positionsOf(s.pub, [market], s.address)
    const heldOnSide = side === 'YES' ? held.yes : held.no
    if (heldOnSide + amount > config.maxStakePerSide) {
      throw new UserError(
        `This wallet already holds ${usdc(heldOnSide)} on ${side} here; ${usdc(amount)} more would go over BOPSTER_MAX_STAKE_PER_SIDE (${usdc(config.maxStakePerSide)}).`,
      )
    }
    if (held.yes + held.no + amount > config.maxStakePerMarket) {
      throw new UserError(
        `This wallet already holds ${usdc(held.yes + held.no)} in this market; ${usdc(amount)} more would go over BOPSTER_MAX_STAKE_PER_MARKET (${usdc(config.maxStakePerMarket)}).`,
      )
    }
    const { eth, usdc: balance } = await balances(s.pub, s.ctx.token, s.address)
    if (eth < config.minEth) throw new UserError(`Only ${formatEther(eth)} ETH for gas (minimum ${formatEther(config.minEth)}).`)
    if (balance < amount) throw new UserError(`The wallet only holds ${usdc(balance)}.`)

    const info = await s.mcp.call('get_market', { address: market }).catch(() => null)
    const quote = await s.mcp.call('quote_position', { market, side, amount: formatUnits(amount, USDC_DECIMALS) })
    log(`
  Market:    ${info?.metadata_question ?? market}
  Closes:    ${quote.closesAt}
  You hold:  YES ${usdc(held.yes)}, NO ${usdc(held.no)}
  New:       ${side} ${usdc(amount)}, pays ${quote.payoutIfWins} if ${side} wins (x${quote.multiplierIfWins} with the pools as they are now)
  Wallet:    ${s.address} (${formatEther(eth)} ETH, ${usdc(balance)})`)
    for (const warning of quote.warnings ?? []) log(`  Warning: ${warning}`)

    if (!(await confirm(`Take ${side} with ${usdc(amount)}?`, { yes }))) return log('  Cancelled. Nothing sent.')
    await placePosition(s, { market, side, amount })
    log('\n  ✓ Done.')
  } finally {
    await s.close()
  }
}
