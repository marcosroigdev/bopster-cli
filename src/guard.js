import { decodeFunctionData, getAddress, isAddress } from 'viem'

import { erc20Abi, factoryAbi, marketAbi, realityAbi } from './abis.js'
import { GuardError } from './errors.js'

/**
 * Every transaction the MCP prepares is checked here before it's signed: who it goes to, the
 * function, every argument, no ETH attached and a sane gas limit. If the MCP is wrong or
 * compromised, the worst case is a refusal here.
 *
 * `ctx` holds what was read from the chain and config, not from the MCP:
 *   token, reality, factory    the factory's own token and Reality.eth addresses, and the factory
 *   arbitrator, realityTimeoutSeconds
 *   knownMarkets               lowercase addresses the factory's registry lists (or its own
 *                              MarketCreated event, for a market this wallet just made)
 */

export const MARKET_CALLS = ['lock', 'finalize', 'triggerEmergencyRefund', 'claim', 'claimRefund']

const GAS_CAPS = { createMarket: 3_000_000n }
const DEFAULT_GAS_CAP = 600_000n

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

function common(tx, action, label) {
  if (!tx || typeof tx !== 'object') throw new GuardError(`${label}: the MCP didn't return a transaction.`)
  if (tx.action !== action) throw new GuardError(`${label}: expected "${action}", but the MCP prepared "${tx.action}".`)
  if (!isAddress(tx.to ?? '')) throw new GuardError(`${label}: invalid destination (${tx.to}).`)
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(tx.data)) throw new GuardError(`${label}: invalid data.`)
  if (!/^\d+$/.test(String(tx.value ?? '0')) || BigInt(tx.value ?? 0) !== 0n) {
    throw new GuardError(`${label}: it carries ${tx.value} wei of ETH; this CLI never sends ETH to a contract.`)
  }
  if (!/^\d+$/.test(String(tx.gas ?? ''))) throw new GuardError(`${label}: no gas limit.`)
  const gas = BigInt(tx.gas)
  const cap = GAS_CAPS[action] ?? DEFAULT_GAS_CAP
  if (gas === 0n || gas > cap) throw new GuardError(`${label}: gas limit ${gas} out of range (max ${cap}).`)
  return getAddress(tx.to)
}

function decode(abi, tx, functionName, label) {
  let decoded
  try {
    decoded = decodeFunctionData({ abi, data: tx.data })
  } catch {
    throw new GuardError(`${label}: unrecognized transaction data.`)
  }
  if (decoded.functionName !== functionName) {
    throw new GuardError(`${label}: it calls ${decoded.functionName}, not ${functionName}.`)
  }
  return decoded.args ?? []
}

function requireMarket(market, ctx, label) {
  if (!ctx.knownMarkets.has(String(market).toLowerCase())) {
    throw new GuardError(`${label}: ${market} isn't a market from the Bopster factory.`)
  }
}

/**
 * The login message, before it's signed: exactly the backend's three lines for this wallet.
 * A signature over anything else could be replayed somewhere it means more.
 */
export function checkLoginMessage(login, wallet) {
  const nonce = String(login?.nonce ?? '')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) throw new GuardError('login: invalid nonce.')
  const expected = `Bopster Fun login\naddress=${wallet.toLowerCase()}\nnonce=${nonce}`
  if (login.message !== expected) throw new GuardError("login: that message isn't Bopster's login for this wallet.")
}

/** The Reality.eth question: template 0, the exact text shown to the operator, Bopster's arbitrator and window. */
export function checkAskQuestion(tx, { question, openingTs }, ctx) {
  const label = 'askQuestion'
  const to = common(tx, 'askQuestion', label)
  if (!same(to, ctx.reality)) throw new GuardError(`${label}: it goes to ${to}, not the factory's Reality.eth (${ctx.reality}).`)
  const [templateId, text, arbitrator, timeout, opening] = decode(realityAbi, tx, 'askQuestion', label)
  if (templateId !== 0n) throw new GuardError(`${label}: Reality template ${templateId}, not 0 (yes/no).`)
  if (text !== question) throw new GuardError(`${label}: the text it would send isn't the question shown.`)
  if (!same(arbitrator, ctx.arbitrator)) throw new GuardError(`${label}: arbitrator ${arbitrator}, not Bopster's (${ctx.arbitrator}).`)
  if (Number(timeout) !== ctx.realityTimeoutSeconds) {
    throw new GuardError(`${label}: answer window of ${timeout} s, not ${ctx.realityTimeoutSeconds} s.`)
  }
  if (BigInt(opening) !== BigInt(openingTs)) throw new GuardError(`${label}: opens to answers at ${opening}, not ${openingTs}.`)
}

/** The market itself: on the factory, on the question this wallet just asked, with the drafted times and metadata. */
export function checkCreateMarket(tx, { questionId, metadataUri, endTime, resolveTime }, ctx) {
  const label = 'createMarket'
  const to = common(tx, 'createMarket', label)
  if (!same(to, ctx.factory)) throw new GuardError(`${label}: it goes to ${to}, not the factory (${ctx.factory}).`)
  const [qid, uri, end, resolve] = decode(factoryAbi, tx, 'createMarket', label)
  if (!same(qid, questionId)) throw new GuardError(`${label}: it uses question ${qid}, not the one this wallet just asked (${questionId}).`)
  if (uri !== metadataUri) throw new GuardError(`${label}: metadata ${uri}, not ${metadataUri}.`)
  if (BigInt(end) !== BigInt(endTime) || BigInt(resolve) !== BigInt(resolveTime)) {
    throw new GuardError(`${label}: times ${end}/${resolve}, not ${endTime}/${resolveTime}.`)
  }
}

/** A position: an approval of exactly the stake to that market, then positionYes/positionNo of the stake. */
export function checkPosition(txs, { market, side, amount }, ctx) {
  const label = `${side} position`
  requireMarket(market, ctx, label)
  if (!Array.isArray(txs) || txs.length !== 2) {
    throw new GuardError(`${label}: expected approve + position, but the MCP prepared ${txs?.length ?? 0} transactions.`)
  }
  const [approve, position] = txs

  const approveTo = common(approve, 'approve', `${label} (approve)`)
  if (!same(approveTo, ctx.token)) throw new GuardError(`${label}: the approve goes to ${approveTo}, not the factory's USDC (${ctx.token}).`)
  const [spender, approved] = decode(erc20Abi, approve, 'approve', `${label} (approve)`)
  if (!same(spender, market)) throw new GuardError(`${label}: the approve lets ${spender} spend, not the market ${market}.`)
  if (approved !== amount) throw new GuardError(`${label}: the approve is for ${approved}, not ${amount}.`)

  const fn = side === 'YES' ? 'positionYes' : 'positionNo'
  const positionTo = common(position, fn, label)
  if (!same(positionTo, market)) throw new GuardError(`${label}: it goes to ${positionTo}, not the market ${market}.`)
  const [staked] = decode(marketAbi, position, fn, label)
  if (staked !== amount) throw new GuardError(`${label}: it stakes ${staked}, not ${amount}.`)
}

/** Settling and claiming: argument-less calls to that market, with at most one claim, last. */
export function checkMarketCalls(txs, { market }, ctx) {
  const label = `claim on ${market}`
  requireMarket(market, ctx, label)
  if (!Array.isArray(txs) || txs.length === 0) throw new GuardError(`${label}: the MCP prepared no transactions.`)
  const actions = txs.map((tx) => tx?.action)
  if (new Set(actions).size !== actions.length) throw new GuardError(`${label}: the same call comes more than once (${actions.join(', ')}).`)
  txs.forEach((tx, i) => {
    if (!MARKET_CALLS.includes(tx?.action)) throw new GuardError(`${label}: unexpected action "${tx?.action}".`)
    const to = common(tx, tx.action, label)
    if (!same(to, market)) throw new GuardError(`${label}: ${tx.action} goes to ${to}, not the market.`)
    const args = decode(marketAbi, tx, tx.action, label)
    if (args.length !== 0) throw new GuardError(`${label}: ${tx.action} takes no arguments.`)
    const isClaim = tx.action === 'claim' || tx.action === 'claimRefund'
    if (isClaim && i !== txs.length - 1) throw new GuardError(`${label}: the claim must be the last transaction.`)
  })
}
