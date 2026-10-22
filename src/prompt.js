import { createInterface } from 'node:readline/promises'

import { UserError } from './errors.js'

/** Asks before spending. `--yes` skips it; without a terminal and without --yes, nothing is sent. */
export async function confirm(question, { yes }) {
  if (yes) return true
  if (!process.stdin.isTTY) throw new UserError('This needs your confirmation: run it in a terminal, or add --yes.')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`\n${question} Type "yes" to go ahead: `)
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}
