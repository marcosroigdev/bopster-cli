import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeFunctionData } from 'viem'

import { erc20Abi, factoryAbi, marketAbi, realityAbi } from '../src/abis.js'
import { GuardError } from '../src/errors.js'
import { checkAskQuestion, checkCreateMarket, checkLoginMessage, checkMarketCalls, checkPosition } from '../src/guard.js'

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const REALITY = '0x2F39f464d16402Ca3D8527dA89617b73DE2F60e8'
const FACTORY = '0x11a2a549286567f7427d990423e5a3560ea16750'
const ARBITRATOR = '0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6'
const MARKET = '0x1111111111111111111111111111111111111111'
const ATTACKER = '0x000000000000000000000000000000000000bEEF'
const WALLET = '0x2222222222222222222222222222222222222222'

const ctx = {
  token: TOKEN,
  reality: REALITY,
  factory: FACTORY,
  arbitrator: ARBITRATOR,
  realityTimeoutSeconds: 43_200,
  knownMarkets: new Set([MARKET.toLowerCase()]),
}

const tx = (action, to, data, extra = {}) => ({ step: 1, action, to, data, value: '0', gas: '250000', ...extra })
const refuses = (fn, pattern) => assert.throws(fn, (error) => error instanceof GuardError && pattern.test(error.message))

describe('checkPosition', () => {
  const amount = 5_000_000n
  const approve = (spender = MARKET, value = amount, to = TOKEN) =>
    tx('approve', to, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] }), { gas: '120000' })
  const positionYes = (value = amount, to = MARKET) =>
    tx('positionYes', to, encodeFunctionData({ abi: marketAbi, functionName: 'positionYes', args: [value] }))

  it('accepts an exact approval to the market, then the position', () => {
    checkPosition([approve(), positionYes()], { market: MARKET, side: 'YES', amount }, ctx)
  })

  it('refuses an approval that lets anyone but the market spend', () => {
    refuses(() => checkPosition([approve(ATTACKER), positionYes()], { market: MARKET, side: 'YES', amount }, ctx), /lets .* spend/)
  })

  it('refuses an approval larger than the stake', () => {
    refuses(() => checkPosition([approve(MARKET, 2n ** 256n - 1n), positionYes()], { market: MARKET, side: 'YES', amount }, ctx), /approve is for/)
  })

  it('refuses an approval on a token other than the factory USDC', () => {
    refuses(() => checkPosition([approve(MARKET, amount, ATTACKER), positionYes()], { market: MARKET, side: 'YES', amount }, ctx), /factory's USDC/)
  })

  it('refuses the other side, another amount or another contract', () => {
    const positionNo = tx('positionNo', MARKET, encodeFunctionData({ abi: marketAbi, functionName: 'positionNo', args: [amount] }))
    refuses(() => checkPosition([approve(), positionNo], { market: MARKET, side: 'YES', amount }, ctx), /expected "positionYes"/)
    refuses(() => checkPosition([approve(), positionYes(amount * 2n)], { market: MARKET, side: 'YES', amount }, ctx), /stakes/)
    refuses(() => checkPosition([approve(), positionYes(amount, ATTACKER)], { market: MARKET, side: 'YES', amount }, ctx), /not the market/)
  })

  it('refuses a market the factory never deployed', () => {
    refuses(() => checkPosition([approve(ATTACKER), positionYes(amount, ATTACKER)], { market: ATTACKER, side: 'YES', amount }, ctx), /isn't a market/)
  })

  it('refuses ETH attached, a missing approve, or an absurd gas limit', () => {
    refuses(() => checkPosition([approve(), { ...positionYes(), value: '1' }], { market: MARKET, side: 'YES', amount }, ctx), /ETH/)
    refuses(() => checkPosition([positionYes()], { market: MARKET, side: 'YES', amount }, ctx), /approve \+ position/)
    refuses(() => checkPosition([approve(), { ...positionYes(), gas: '5000000' }], { market: MARKET, side: 'YES', amount }, ctx), /gas/)
  })

  it('refuses data that says one thing while the action label says another', () => {
    const disguised = tx('positionYes', MARKET, encodeFunctionData({ abi: marketAbi, functionName: 'claim' }))
    refuses(() => checkPosition([approve(), disguised], { market: MARKET, side: 'YES', amount }, ctx), /calls claim/)
  })
})

describe('checkAskQuestion', () => {
  const question = 'Will BTC be above $150000 on 2026-10-20 18:30 UTC?'
  const ask = ({ template = 0n, text = question, arbitrator = ARBITRATOR, timeout = 43_200, opening = 1_792_521_000, to = REALITY } = {}) =>
    tx(
      'askQuestion',
      to,
      encodeFunctionData({ abi: realityAbi, functionName: 'askQuestion', args: [template, text, arbitrator, timeout, opening, 1n] }),
      { gas: '200000' },
    )
  const expected = { question, openingTs: 1_792_521_000 }

  it('accepts the question shown, on the factory Reality.eth, with Bopster arbitrator and window', () => {
    checkAskQuestion(ask(), expected, ctx)
  })

  it('refuses any other text, template, arbitrator, window, opening time or contract', () => {
    refuses(() => checkAskQuestion(ask({ text: `${question} ` }), expected, ctx), /text/)
    refuses(() => checkAskQuestion(ask({ arbitrator: ATTACKER }), expected, ctx), /arbitrator/)
    refuses(() => checkAskQuestion(ask({ timeout: 60 }), expected, ctx), /answer window/)
    refuses(() => checkAskQuestion(ask({ template: 2n }), expected, ctx), /template/)
    refuses(() => checkAskQuestion(ask({ opening: 1 }), expected, ctx), /opens/)
    refuses(() => checkAskQuestion(ask({ to: ATTACKER }), expected, ctx), /Reality/)
  })
})

describe('checkCreateMarket', () => {
  const questionId = `0x${'ab'.repeat(32)}`
  const launch = ({ qid = questionId, uri = 'ipfs://bafy', end = 100n, resolve = 200n, to = FACTORY } = {}) =>
    tx('createMarket', to, encodeFunctionData({ abi: factoryAbi, functionName: 'createMarket', args: [qid, uri, end, resolve] }), {
      gas: '2800000',
    })
  const expected = { questionId, metadataUri: 'ipfs://bafy', endTime: 100, resolveTime: 200 }

  it('accepts the market on the question this wallet just asked', () => {
    checkCreateMarket(launch(), expected, ctx)
  })

  it('refuses another question, other metadata, other times or another contract', () => {
    refuses(() => checkCreateMarket(launch({ qid: `0x${'cd'.repeat(32)}` }), expected, ctx), /question/)
    refuses(() => checkCreateMarket(launch({ uri: 'ipfs://other' }), expected, ctx), /metadata/)
    refuses(() => checkCreateMarket(launch({ end: 101n }), expected, ctx), /times/)
    refuses(() => checkCreateMarket(launch({ to: ATTACKER }), expected, ctx), /factory/)
  })
})

describe('checkMarketCalls', () => {
  const call = (fn, to = MARKET) => tx(fn, to, encodeFunctionData({ abi: marketAbi, functionName: fn }), { gas: fn === 'finalize' ? '500000' : '300000' })

  it('accepts settling and then claiming on the market', () => {
    checkMarketCalls([call('finalize'), call('claim')], { market: MARKET }, ctx)
    checkMarketCalls([call('claimRefund')], { market: MARKET }, ctx)
  })

  it('refuses calls to another contract, a claim before the end, repeats, or anything else', () => {
    refuses(() => checkMarketCalls([call('claim', ATTACKER)], { market: MARKET }, ctx), /not the market/)
    refuses(() => checkMarketCalls([call('claim'), call('finalize')], { market: MARKET }, ctx), /last/)
    refuses(() => checkMarketCalls([call('finalize'), call('finalize'), call('claim')], { market: MARKET }, ctx), /more than once/)
    const approve = tx('approve', TOKEN, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ATTACKER, 1n] }))
    refuses(() => checkMarketCalls([approve], { market: MARKET }, ctx), /unexpected/)
  })
})

describe('checkLoginMessage', () => {
  it('accepts exactly the backend login message for this wallet', () => {
    checkLoginMessage({ nonce: 'abc123', message: `Bopster Fun login\naddress=${WALLET}\nnonce=abc123` }, WALLET)
  })

  it('refuses anything else to sign', () => {
    refuses(() => checkLoginMessage({ nonce: 'abc123', message: `Bopster Fun login\naddress=${ATTACKER.toLowerCase()}\nnonce=abc123` }, WALLET), /login/)
    refuses(() => checkLoginMessage({ nonce: 'abc123', message: 'Transfer all funds' }, WALLET), /login/)
    refuses(() => checkLoginMessage({ nonce: 'a\nb', message: `Bopster Fun login\naddress=${WALLET}\nnonce=a\nb` }, WALLET), /nonce/)
  })
})
