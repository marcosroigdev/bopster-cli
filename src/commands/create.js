import { resolve } from 'node:path'

import { formatEther } from 'viem'

import { usdc } from '../amounts.js'
import { balances, marketCreatedIn, positionsOf, questionIdIn } from '../chain.js'
import { GuardError, ReceiptTimeoutError, UserError } from '../errors.js'
import { checkAskQuestion, checkCreateMarket } from '../guard.js'
import { login } from '../mcp.js'
import { loadPlan, validatePlan } from '../plan.js'
import { confirm } from '../prompt.js'
import { loadRun, runPathFor, saveRun } from '../runs.js'
import { openSession } from '../session.js'
import { placePosition } from './positions.js'

const SIDES = ['YES', 'NO']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `create <plan.json>...`: each plan becomes a market, through the same four MCP steps the site
 * walks a person through, then the plan's positions on it. Every step is saved in runs/, and running
 * the same plan again picks up where it stopped.
 */
export async function create(config, planPaths, { yes, allowLowTrust, log }) {
  if (planPaths.length === 0) throw new UserError('Usage: create <plan.json> [more plans...] [--yes]')
  // Every plan is checked before the first one starts.
  for (const path of planPaths) prepareRun(config, path)

  const s = await openSession(config, { needKey: true, log })
  try {
    for (const path of planPaths) await createOne(s, path, { yes, allowLowTrust })
  } finally {
    await s.close()
  }
}

function prepareRun(config, path) {
  const { raw, hash } = loadPlan(path)
  const runPath = runPathFor(config, path)
  const run = loadRun(runPath)
  const ranFrom = run && resolve(run.planPath ?? run.plan)
  if (run && ranFrom !== resolve(path)) {
    throw new UserError(`${runPath} is the run of ${ranFrom}, another plan with the same file name. Rename ${path}.`)
  }
  if (run && !run.done && run.network !== config.networkName) {
    throw new UserError(`${path} was started on ${run.network}. Set BOPSTER_NETWORK=${run.network} to finish it.`)
  }
  if (run && !run.done && run.planHash !== hash) {
    throw new UserError(
      `${path} changed after its market started (${runPath}). Undo the change to finish it, or copy the plan under another name to create a new one.`,
    )
  }
  const plan = validatePlan(raw, { ...config, checkTiming: !run?.questionTx })
  return { hash, runPath, run, plan }
}

async function createOne(s, path, { yes, allowLowTrust }) {
  const { log, config, ctx } = s
  const prepared = prepareRun(config, path)
  const { hash, runPath, plan } = prepared
  let run = prepared.run
  const save = () => saveRun(runPath, run)

  log(`\n${path}`)
  if (run?.done) return log(`  Already created: ${run.url ?? run.market}. Nothing to do.`)
  if (run?.wallet && run.wallet.toLowerCase() !== s.address.toLowerCase()) {
    throw new UserError(`${path} was started from ${run.wallet}, not ${s.address}. Finish it with that wallet.`)
  }

  const placed = (side) => run?.positions?.[side]?.done === true
  const stakeLeft = SIDES.reduce((sum, side) => (placed(side) ? sum : sum + plan.stakes[side]), 0n)
  const { eth, usdc: balance } = await balances(s.pub, ctx.token, s.address)
  if (eth < config.minEth) throw new UserError(`Only ${formatEther(eth)} ETH for gas (minimum ${formatEther(config.minEth)}).`)
  if (balance < stakeLeft) throw new UserError(`This needs ${usdc(stakeLeft)} and the wallet holds ${usdc(balance)}.`)

  // 1. The question, drafted by the MCP from the template, shown, confirmed, then asked on Reality.eth.
  if (!run?.questionTx) {
    const { nonce, signature } = await login(s.mcp, s.account, log)
    log('  Drafting the question: the MCP checks the template and pins the metadata to IPFS...')
    const q = await s.mcp.call('prepare_market_question', { ...plan.mcpArgs, wallet: s.account.address, nonce, signature })
    const draft = q.next?.arguments
    if (!draft || draft.end_time !== plan.endTime) throw new GuardError("The MCP drafted a close time that isn't the plan's.")
    if (draft.resolve_time !== plan.resolveTime) {
      throw new GuardError(`The MCP drafted a resolve time of ${draft.resolve_time}, not the plan's ${plan.resolveTime}.`)
    }
    if (draft.question !== q.question) throw new GuardError("The draft's question isn't the one shown.")
    checkAskQuestion(q.transactions?.[0], { question: q.question, openingTs: draft.resolve_time }, ctx)

    log(`
  Market to create as ${q.creator ?? s.address}:
    Title:      ${q.title}
    Question:   ${q.question}
    Category:   ${q.category}
    Source:     ${q.sourceUrl}
    Closes:     ${q.closesAt}
    Resolves:   ${q.resolvesAt} (the oracle opens then)
    Positions:  ${plan.stakes.YES + plan.stakes.NO > 0n ? `YES ${usdc(plan.stakes.YES)}, NO ${usdc(plan.stakes.NO)}` : 'none'}
    Wallet:     ${s.address} (${formatEther(eth)} ETH, ${usdc(balance)})`)
    for (const warning of q.warnings ?? []) log(`    Warning: ${warning}`)

    const ask = plan.stakes.YES + plan.stakes.NO > 0n ? 'Create this market and take these positions?' : 'Create this market?'
    if (!(await confirm(ask, { yes }))) return log('  Cancelled. Nothing sent.')

    run = {
      plan: path,
      planPath: resolve(path),
      planHash: hash,
      network: config.networkName,
      wallet: s.address,
      title: q.title,
      question: q.question,
      closesAt: q.closesAt,
      resolvesAt: q.resolvesAt,
      draft,
      startedAt: new Date().toISOString(),
    }
    save()
    const receipt = await s.sender.send(q.transactions[0], 'askQuestion', (txHash) => {
      run.questionTx = txHash
      save()
    })
    run.questionId = questionIdIn(receipt, ctx.reality)
    save()
  } else {
    log(`  Resuming the market started at ${run.startedAt}: "${run.question}"`)
    if (!run.questionId) {
      const receipt = await waitForSaved(s, run.questionTx, 'askQuestion', runPath, 'questionTx')
      run.questionId = questionIdIn(receipt, ctx.reality)
      save()
    }
  }

  // 2. The market, on the question just asked, and its registration with the backend.
  if (!run.market) {
    let receipt
    if (!run.marketTx) {
      const launch = await s.mcp.callRetrying(
        'prepare_market_launch',
        { ...run.draft, question_tx_hash: run.questionTx },
        { attempts: 6, delayMs: 5_000, log },
      )
      checkCreateMarket(
        launch.transactions?.[0],
        {
          questionId: run.questionId,
          metadataUri: run.draft.metadata_uri,
          endTime: run.draft.end_time,
          resolveTime: run.draft.resolve_time,
        },
        ctx,
      )
      receipt = await s.sender.send(launch.transactions[0], 'createMarket', (txHash) => {
        run.marketTx = txHash
        save()
      })
    } else {
      receipt = await waitForSaved(s, run.marketTx, 'createMarket', runPath, 'marketTx')
    }
    run.market = marketCreatedIn(receipt, ctx.factory)
    save()
  }
  // From the factory's own MarketCreated event in this wallet's transaction: no registry read needed.
  ctx.knownMarkets.add(run.market.toLowerCase())

  if (run.registered === undefined) {
    try {
      const registration = await s.mcp.callRetrying('register_market', { tx_hash: run.marketTx }, { attempts: 6, delayMs: 10_000, log })
      if (registration.market?.toLowerCase() !== run.market.toLowerCase()) {
        log(`  Warning: register_market names ${registration.market}; going on with ${run.market}, the transaction's.`)
      }
      run.url = registration.url ?? null
      run.registered = registration.registered !== false
    } catch (error) {
      log(`  Warning: ${error.message}. The backend's indexer will pick it up.`)
      run.registered = false
    }
    save()
  }
  log(`  Market: ${run.market}${run.url ? ` (${run.url})` : ''}`)

  // 3. The plan's positions, only on a market the backend trusts.
  const pending = SIDES.filter((side) => plan.stakes[side] > 0n && !placed(side))
  if (pending.length > 0 && !run.quality) {
    const tier = await qualityTier(s, run.market)
    if (tier && tier !== 'high_trust' && !allowLowTrust) {
      throw new UserError(
        `The backend scored the market ${tier}, so it won't be featured. No positions taken. Find out why; to take them anyway, run it again with --allow-low-trust.`,
      )
    }
    if (!tier) {
      throw new UserError("The backend doesn't show the market yet, so no positions were taken. Run the same command again in a minute.")
    }
    run.quality = tier
    save()
  }

  run.positions ??= {}
  for (const side of pending) {
    const amount = plan.stakes[side]
    const entry = (run.positions[side] ??= {})
    if (entry.tx) {
      // Sent before this run stopped: it either went through or it didn't.
      let receipt
      try {
        receipt = await s.sender.receipt(entry.tx, `${side} position`)
      } catch (error) {
        if (!(error instanceof ReceiptTimeoutError)) throw error
        throw new UserError(
          `${error.message} If the explorer doesn't show it, it never went out: remove "tx" from positions.${side} in ${runPath} and run the plan again.`,
        )
      }
      if (receipt.status === 'success') {
        entry.done = true
        save()
        continue
      }
      log(`  The earlier ${side} position reverted on chain; sending it again.`)
      delete entry.tx
    }
    const [held] = await positionsOf(s.pub, [run.market], s.address)
    if ((side === 'YES' ? held.yes : held.no) >= amount) {
      entry.done = true
      save()
      continue
    }
    await placePosition(s, {
      market: run.market,
      side,
      amount,
      onHash: (txHash) => {
        entry.tx = txHash
        save()
      },
    })
    entry.done = true
    save()
  }

  run.done = true
  run.finishedAt = new Date().toISOString()
  save()
  log(`\n  ✓ Done: ${run.url ?? run.market}`)
  log(`    YES ${usdc(plan.stakes.YES)}, NO ${usdc(plan.stakes.NO)}, closes ${run.closesAt}`)
}

/**
 * A transaction saved by an earlier run. If it never confirms or it reverted, the hint names the
 * field to remove from the run file so that step is prepared and sent again.
 */
async function waitForSaved(s, txHash, label, runPath, field) {
  try {
    return await s.sender.waitFor(txHash, label)
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    const why = error instanceof ReceiptTimeoutError ? "If the explorer doesn't show it, it never went out" : 'It reverted'
    throw new UserError(`${error.message} ${why}: remove "${field}" from ${runPath} and run the plan again.`)
  }
}

/** The backend's trust tier for the market, once it shows it; null if it doesn't within a minute. */
async function qualityTier(s, market) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const view = await s.mcp.call('get_market', { address: market })
      const tier = (view.market ?? view).quality_tier
      if (tier) return tier
    } catch {
      // Not indexed yet.
    }
    if (attempt < 6) await sleep(10_000)
  }
  return null
}
