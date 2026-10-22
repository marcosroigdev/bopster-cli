#!/usr/bin/env node
import { check } from './commands/check.js'
import { claim, status } from './commands/claims.js'
import { create } from './commands/create.js'
import { position } from './commands/positions.js'
import { validate } from './commands/validate.js'
import { loadConfig } from './config.js'
import { UserError } from './errors.js'

const USAGE = `bopster-cli: create Bopster markets, take positions and claim, through the Bopster MCP,
signing with your own wallet.

  npm run bop -- check                               config, key, balances and MCP; sends nothing
  npm run bop -- validate <plan.json> [more...]      checks plans locally (shape, dates, caps)
  npm run bop -- create <plan.json> [more...]        creates each market and takes the plan's positions
  npm run bop -- position <market> <YES|NO> <USDC>   one position on a market that already exists
  npm run bop -- status [market...]                  your positions and what you can claim; sends nothing
  npm run bop -- claim [market...]                   settles if needed, then claims payouts and refunds

  --yes              don't ask for confirmation (for automation)
  --allow-low-trust  (create) take positions even if the backend scores the market below high_trust

Every transaction is checked against the factory, and the USDC and Reality.eth it uses, before
anything is signed. Config: .env (see .env.example).`

const log = (...args) => console.log(...args)

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const [command, ...args] = argv.filter((a) => !a.startsWith('--'))
  const known = new Set(['--yes', '--allow-low-trust', '--help'])
  const unknown = [...flags].filter((f) => !known.has(f))
  if (unknown.length) throw new UserError(`Unknown option: ${unknown.join(', ')}`)
  if (!command || flags.has('--help')) return log(USAGE)

  const config = loadConfig()
  const options = { yes: flags.has('--yes'), allowLowTrust: flags.has('--allow-low-trust'), log }
  switch (command) {
    case 'check':
      return check(config, options)
    case 'validate':
      return validate(config, args, options)
    case 'create':
      return create(config, args, options)
    case 'position':
      return position(config, args, options)
    case 'status':
      return status(config, args, options)
    case 'claim':
      return claim(config, args, options)
    default:
      throw new UserError(`Unknown command: ${command}\n\n${USAGE}`)
  }
}

try {
  await main(process.argv.slice(2))
  process.exit(0)
} catch (error) {
  if (error instanceof UserError) {
    console.error(`\n✗ ${error.message}`)
  } else {
    console.error('\n✗ Unexpected error:', error)
  }
  process.exit(1)
}
