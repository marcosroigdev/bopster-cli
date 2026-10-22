import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { parseAmount, usdc } from './amounts.js'
import { UserError } from './errors.js'

/**
 * A plan is one market to create, in a JSON file: the prepare_market_question fields plus the
 * stake on each side. Only the shape, the stakes and the dates are checked here; the template
 * rules are the MCP's, which checks them before anything is signed.
 */

export const TEMPLATE_TYPES = ['price_threshold', 'event_outcome', 'before_date', 'price_change', 'compare_assets']
const KNOWN_KEYS = new Set([
  'title',
  'category',
  'template',
  'source_url',
  'end_time',
  'resolution_delay_minutes',
  'sports_match',
  'accept_terms',
  'positions',
  'notes',
])
const MIN_LEAD_MS = 20 * 60_000
const MAX_LEAD_MS = 10 * 24 * 60 * 60_000

// Resolution delays offered on the site, in minutes. A match uses its sport's delay instead.
export const RESOLUTION_DELAYS = [15, 30, 60, 120, 180, 210, 240, 300, 360, 720, 1440, 2880, 4320, 5760, 7200]
const DEFAULT_DELAY = 30
const MATCH_DELAYS = {
  football: 180,
  'football-knockout': 240,
  basketball: 180,
  'ice-hockey': 210,
  rugby: 180,
  'american-football-baseball': 240,
  'formula-1': 240,
}

export function loadPlan(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UserError(`Can't read the plan ${path}.`)
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new UserError(`${path} isn't valid JSON: ${error.message}`)
  }
  return { raw, hash: createHash('sha256').update(text).digest('hex') }
}

/**
 * Checks a plan and splits it into the MCP's arguments and the stakes, in USDC base units.
 * `checkTiming` is off when resuming a market already under way: its close was checked when it
 * started, and the MCP and the contracts refuse anything that's too late now.
 */
export function validatePlan(raw, { now = Date.now(), maxStakePerSide, maxStakePerMarket, checkTiming = true }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserError('A plan must be a JSON object.')
  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k))
  if (unknown.length) throw new UserError(`Unknown fields in the plan: ${unknown.join(', ')}.`)

  for (const key of ['title', 'category', 'source_url', 'end_time']) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') throw new UserError(`The plan is missing "${key}".`)
  }
  if (!/^https?:\/\/\S+$/.test(raw.source_url)) throw new UserError('"source_url" must be a public http(s) URL.')
  if (!raw.template || typeof raw.template !== 'object' || !TEMPLATE_TYPES.includes(raw.template.type)) {
    throw new UserError(`"template.type" must be one of: ${TEMPLATE_TYPES.join(', ')}.`)
  }
  // The MCP files any capitalization of "sports" under Sports, which needs sports_match.
  const sports = raw.category.trim().toLowerCase() === 'sports'
  if (sports && !raw.sports_match) {
    throw new UserError('A Sports market needs "sports_match": the sport of the match, "other" or "not_a_match".')
  }
  const delay = resolutionDelay(raw, sports)
  if (raw.accept_terms !== true) {
    throw new UserError('Creating a market accepts the Bopster Fun Terms of Use: set "accept_terms": true in the plan.')
  }

  if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw.end_time) || Number.isNaN(Date.parse(raw.end_time))) {
    throw new UserError(`"end_time" (${raw.end_time}) must be an ISO 8601 date with a timezone, like "2026-10-20T18:00:00Z".`)
  }
  const endMs = Date.parse(raw.end_time)
  if (endMs % 60_000 !== 0) throw new UserError('"end_time" must fall on a whole minute (seconds at 0).')
  if (checkTiming && endMs - now < MIN_LEAD_MS) throw new UserError(`"end_time" (${raw.end_time}) must be at least 20 minutes from now.`)
  if (checkTiming && endMs - now > MAX_LEAD_MS) throw new UserError(`"end_time" (${raw.end_time}) can't be more than 10 days from now.`)

  const positions = raw.positions ?? {}
  if (typeof positions !== 'object' || Array.isArray(positions)) throw new UserError('"positions" must look like { "yes": "5", "no": "5" }.')
  const extra = Object.keys(positions).filter((k) => k !== 'yes' && k !== 'no')
  if (extra.length) throw new UserError(`"positions" only takes "yes" and "no" (extra: ${extra.join(', ')}).`)
  const stakes = {
    YES: positions.yes === undefined ? 0n : parseAmount(positions.yes, undefined, 'positions.yes'),
    NO: positions.no === undefined ? 0n : parseAmount(positions.no, undefined, 'positions.no'),
  }
  for (const side of ['YES', 'NO']) {
    if (stakes[side] > maxStakePerSide) {
      throw new UserError(`${side} ${usdc(stakes[side])} is over BOPSTER_MAX_STAKE_PER_SIDE (${usdc(maxStakePerSide)}).`)
    }
  }
  if (stakes.YES + stakes.NO > maxStakePerMarket) {
    throw new UserError(`YES + NO = ${usdc(stakes.YES + stakes.NO)} is over BOPSTER_MAX_STAKE_PER_MARKET (${usdc(maxStakePerMarket)}).`)
  }

  const { positions: _positions, notes: _notes, ...mcpArgs } = raw
  const endTime = endMs / 1000
  return { mcpArgs, stakes, endTime, resolveTime: endTime + delay * 60 }
}

/** Minutes between close and resolve, worked out like the MCP and the site do. */
function resolutionDelay(raw, sports) {
  const given = raw.resolution_delay_minutes
  if (given !== undefined && !RESOLUTION_DELAYS.includes(given)) {
    throw new UserError(`"resolution_delay_minutes" must be one of ${RESOLUTION_DELAYS.join(', ')}.`)
  }
  const sport = sports ? raw.sports_match : undefined
  if (sport in MATCH_DELAYS) {
    if (given !== undefined && given !== MATCH_DELAYS[sport]) {
      throw new UserError(`A ${sport} match resolves ${MATCH_DELAYS[sport]} minutes after kick-off: leave "resolution_delay_minutes" out.`)
    }
    return MATCH_DELAYS[sport]
  }
  if (sport === 'other' && given === undefined) {
    throw new UserError('"sports_match": "other" needs "resolution_delay_minutes", long enough for the match to end.')
  }
  return given ?? DEFAULT_DELAY
}
