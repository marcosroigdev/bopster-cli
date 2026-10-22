import { formatEther, getAddress, isAddress } from 'viem'

import { usdc } from '../amounts.js'
import { balances, loadFactoryMarkets, positionsOf } from '../chain.js'
import { ReceiptTimeoutError, UserError } from '../errors.js'
import { checkMarketCalls } from '../guard.js'
import { confirm } from '../prompt.js'
import { openSession, short } from '../session.js'
import { syncMarket } from './positions.js'

const CLAIMABLE = ['claim', 'refund']

/**
 * The wallet's stake in every Bopster market, read from the chain (the factory's registry and each
 * market's positions), and what the MCP says can be taken out of each one not yet claimed.
 */
async function scan(s, onlyMarkets) {
  const all = await loadFactoryMarkets(s.pub, s.ctx)
  let markets = all
  if (onlyMarkets.length > 0) {
    markets = onlyMarkets.map((m) => {
      if (!isAddress(m)) throw new UserError(`${m} isn't an address.`)
      if (!s.ctx.knownMarkets.has(m.toLowerCase())) throw new UserError(`${m} isn't a market from the Bopster factory.`)
      return getAddress(m)
    })
  }
  const held = (await positionsOf(s.pub, markets, s.address)).filter((p) => p.yes > 0n || p.no > 0n)

  const rows = []
  for (const position of held) {
    if (position.claimed) {
      rows.push({ ...position, outcome: 'already_claimed', summary: 'Already claimed.' })
      continue
    }
    try {
      const plan = await s.mcp.call('prepare_claim', { market: position.market, wallet: s.address })
      rows.push({ ...plan, ...position })
    } catch (error) {
      rows.push({ ...position, outcome: 'error', summary: error.message })
    }
  }
  return rows
}

function printRows(log, rows) {
  if (rows.length === 0) return log('  No positions in any market.')
  for (const row of rows) {
    const stake = `YES ${usdc(row.yes)}, NO ${usdc(row.no)}`
    const what = CLAIMABLE.includes(row.outcome)
      ? `-> ${row.outcome === 'claim' ? 'payout' : 'refund'} of ${row.amount}${row.transactions?.some((t) => t.action === 'finalize') ? ' (settles the market first and takes the resolver reward)' : ''}`
      : row.outcome === 'not_ready'
        ? `- not yet${row.readyAt ? ` (from ${row.readyAt})` : ''}`
        : `- ${row.summary}`
    log(`  ${short(row.market)}  ${stake}  ${what}`)
  }
}

/** `status`: read-only. Works with BOPSTER_WALLET alone, no key. */
export async function status(config, args, { log }) {
  const s = await openSession(config, { needKey: false, log })
  try {
    const { eth, usdc: balance } = await balances(s.pub, s.ctx.token, s.address)
    log(`Wallet ${s.address}: ${formatEther(eth)} ETH, ${usdc(balance)}\n`)
    const rows = await scan(s, args)
    printRows(log, rows)
    const claimable = rows.filter((r) => CLAIMABLE.includes(r.outcome))
    if (claimable.length > 0) log(`\n  ${claimable.length} market(s) with something to claim: npm run bop -- claim`)
  } finally {
    await s.close()
  }
}

/** `claim [market...]`: settles where needed and claims every payout and refund, after one confirmation. */
export async function claim(config, args, { yes, log }) {
  const s = await openSession(config, { needKey: true, log })
  try {
    const rows = (await scan(s, args)).filter((r) => CLAIMABLE.includes(r.outcome))
    if (rows.length === 0) return log('  Nothing to claim right now.')
    for (const row of rows) checkMarketCalls(row.transactions, { market: row.market }, s.ctx)

    printRows(log, rows)
    if (!(await confirm(`Claim on ${rows.length} market(s)?`, { yes }))) return log('  Cancelled. Nothing sent.')

    const before = (await balances(s.pub, s.ctx.token, s.address)).usdc
    let failed = 0
    for (const row of rows) {
      log(`\n  ${row.market}`)
      try {
        let last
        for (const tx of row.transactions) last = await s.sender.send(tx, tx.action)
        await syncMarket(s, row.market, last.transactionHash)
      } catch (error) {
        // One market failing (someone settled it a moment earlier, say) doesn't stop the rest.
        if (!(error instanceof UserError) || error instanceof ReceiptTimeoutError) throw error
        failed++
        log(`  ✗ ${error.message}`)
      }
    }
    const after = (await balances(s.pub, s.ctx.token, s.address)).usdc
    log(`\n  ✓ Claimed: ${usdc(after - before)}${failed ? `, ${failed} market(s) failed: run claim again` : ''}`)
  } finally {
    await s.close()
  }
}
