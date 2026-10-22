import { readFileSync, statSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

import { UserError } from './errors.js'

/**
 * The signer, from a key file only its owner can read. The key is never printed, logged or written
 * anywhere else. With BOPSTER_WALLET set, a key for any other wallet is refused.
 */
export function loadAccount(config) {
  let stat
  try {
    stat = statSync(config.keyFile)
  } catch {
    throw new UserError(`Can't find your key at ${config.keyFile}. See "Storing the key" in the README.`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UserError(`Other users can read ${config.keyFile}. Run: chmod 600 "${config.keyFile}"`)
  }

  const raw = readFileSync(config.keyFile, 'utf8').trim()
  const key = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new UserError(`${config.keyFile} doesn't hold a valid private key (64 hex characters).`)
  }

  const account = privateKeyToAccount(key)
  if (config.expectedAddress && account.address.toLowerCase() !== config.expectedAddress.toLowerCase()) {
    throw new UserError(
      `The key in ${config.keyFile} belongs to ${account.address}, not BOPSTER_WALLET (${config.expectedAddress}). Nothing sent.`,
    )
  }
  return account
}

/** The wallet to read for: BOPSTER_WALLET when set, so read-only commands don't need the key. */
export function readOnlyAddress(config) {
  if (config.expectedAddress) return config.expectedAddress
  return loadAccount(config).address
}
