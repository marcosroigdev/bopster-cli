import { formatUnits } from 'viem'

import { UserError } from './errors.js'

export const USDC_DECIMALS = 6

/** "2.5" -> 2500000n for 6 decimals. Refuses signs, exponents and more precision than the token has. */
export function parseAmount(input, decimals = USDC_DECIMALS, label = 'amount') {
  const text = String(input ?? '').trim()
  if (!/^\d+(\.\d+)?$/.test(text)) throw new UserError(`${label}: "${input}" isn't a valid number (try "5" or "2.5").`)
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) throw new UserError(`${label}: "${input}" has more than ${decimals} decimals.`)
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

export function usdc(raw) {
  return `${formatUnits(raw, USDC_DECIMALS)} USDC`
}
