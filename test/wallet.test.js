import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { UserError } from '../src/errors.js'
import { loadAccount } from '../src/wallet.js'

// A key made for this test and thrown away: no funds, never on any chain.
function keyFile(contents, mode = 0o600) {
  const path = join(mkdtempSync(join(tmpdir(), 'bopster-cli-test-')), 'private-key')
  writeFileSync(path, contents)
  chmodSync(path, mode)
  return path
}
const refuses = (config, pattern) => assert.throws(() => loadAccount(config), (e) => e instanceof UserError && pattern.test(e.message))

describe('loadAccount', () => {
  const key = generatePrivateKey()
  const address = privateKeyToAccount(key).address

  it('loads a key only its owner can read, with or without 0x', () => {
    assert.equal(loadAccount({ keyFile: keyFile(`${key}\n`), expectedAddress: address }).address, address)
    assert.equal(loadAccount({ keyFile: keyFile(key.slice(2)), expectedAddress: null }).address, address)
  })

  it('refuses a key file others can read', () => {
    refuses({ keyFile: keyFile(key, 0o644), expectedAddress: null }, /chmod 600/)
  })

  it('refuses a key for a wallet other than BOPSTER_WALLET', () => {
    refuses({ keyFile: keyFile(generatePrivateKey()), expectedAddress: address }, /not BOPSTER_WALLET/)
  })

  it('refuses a missing or malformed key, without printing it', () => {
    refuses({ keyFile: '/nonexistent/bopster-key', expectedAddress: null }, /Can't find/)
    const bad = 'not-a-key-but-secret-looking'
    assert.throws(
      () => loadAccount({ keyFile: keyFile(bad), expectedAddress: null }),
      (e) => e instanceof UserError && !e.message.includes(bad),
    )
  })
})
