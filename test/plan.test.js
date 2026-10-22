import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { UserError } from '../src/errors.js'
import { validatePlan } from '../src/plan.js'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const limits = { now: NOW, maxStakePerSide: 50_000_000n, maxStakePerMarket: 100_000_000n }
const plan = (overrides = {}) => ({
  title: 'BTC above $150K on Oct 20',
  category: 'Crypto',
  template: { type: 'price_threshold', asset: 'BTC', direction: 'above', price: '150000' },
  source_url: 'https://www.coingecko.com/en/coins/bitcoin',
  end_time: '2026-10-20T18:00:00Z',
  resolution_delay_minutes: 30,
  accept_terms: true,
  positions: { yes: '5', no: '2.5' },
  ...overrides,
})
const refuses = (raw, pattern, options = limits) =>
  assert.throws(() => validatePlan(raw, options), (error) => error instanceof UserError && pattern.test(error.message))

describe('validatePlan', () => {
  it('splits a plan into the MCP arguments and the stakes', () => {
    const { mcpArgs, stakes, endTime } = validatePlan(plan({ notes: 'for the operator' }), limits)
    assert.deepEqual(stakes, { YES: 5_000_000n, NO: 2_500_000n })
    assert.equal(endTime, Date.parse('2026-10-20T18:00:00Z') / 1000)
    assert.equal(mcpArgs.positions, undefined)
    assert.equal(mcpArgs.notes, undefined)
    assert.equal(mcpArgs.accept_terms, true)
  })

  it('needs the terms accepted explicitly', () => {
    refuses(plan({ accept_terms: undefined }), /Terms of Use/)
  })

  it('refuses unknown fields', () => {
    refuses(plan({ end_tme: '2026-10-20T18:00:00Z' }), /Unknown fields/)
  })

  it('only takes the five templates', () => {
    refuses(plan({ template: { type: 'free_text', question: 'Will it rain?' } }), /template.type/)
  })

  it('wants a close 20 minutes to 10 days out, on a whole minute, with a timezone', () => {
    refuses(plan({ end_time: '2026-10-14T12:10:00Z' }), /20 minutes/)
    refuses(plan({ end_time: '2026-10-30T12:00:00Z' }), /10 days/)
    refuses(plan({ end_time: '2026-10-20T18:00:30Z' }), /whole minute/)
    refuses(plan({ end_time: '2026-10-20T18:00:00' }), /timezone/)
  })

  it('skips the close window when resuming a market already under way', () => {
    validatePlan(plan({ end_time: '2026-10-14T12:10:00Z' }), { ...limits, checkTiming: false })
  })

  it('holds stakes to the caps, per side and per market', () => {
    refuses(plan({ positions: { yes: '51' } }), /PER_SIDE/)
    refuses(plan({ positions: { yes: '50', no: '50.000001' } }), /PER_SIDE/)
    refuses(plan({ positions: { yes: '50', no: '50' } }), /PER_MARKET/, { ...limits, maxStakePerMarket: 99_000_000n })
  })

  it('refuses malformed stakes', () => {
    refuses(plan({ positions: { yes: '-5' } }), /valid number/)
    refuses(plan({ positions: { yes: '1e3' } }), /valid number/)
    refuses(plan({ positions: { yes: '0.0000001' } }), /decimals/)
    refuses(plan({ positions: { maybe: '5' } }), /only takes/)
  })

  it('works out the resolve time from the delay, the sport or the default', () => {
    const end = Date.parse('2026-10-20T18:00:00Z') / 1000
    assert.equal(validatePlan(plan(), limits).resolveTime, end + 30 * 60)
    assert.equal(validatePlan(plan({ resolution_delay_minutes: undefined }), limits).resolveTime, end + 30 * 60)
    assert.equal(validatePlan(plan({ resolution_delay_minutes: 1440 }), limits).resolveTime, end + 1440 * 60)
    const match = { category: 'Sports', sports_match: 'football', resolution_delay_minutes: undefined }
    assert.equal(validatePlan(plan(match), limits).resolveTime, end + 180 * 60)
    const notAMatch = { category: 'Sports', sports_match: 'not_a_match', resolution_delay_minutes: 60 }
    assert.equal(validatePlan(plan(notAMatch), limits).resolveTime, end + 60 * 60)
  })

  it('refuses a delay the site does not offer, or one that fights the sport', () => {
    refuses(plan({ resolution_delay_minutes: 45 }), /must be one of/)
    refuses(plan({ category: 'Sports', sports_match: 'football', resolution_delay_minutes: 30 }), /resolves 180 minutes/)
    refuses(plan({ category: 'Sports', sports_match: 'other', resolution_delay_minutes: undefined }), /needs "resolution_delay_minutes"/)
  })

  it('asks a Sports market whether it is a match', () => {
    refuses(plan({ category: 'Sports' }), /sports_match/)
  })
})
