import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keccak256, parseGwei } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import { ReceiptTimeoutError, UserError } from '../src/errors.js'
import { TxSender } from '../src/sender.js'

// A throwaway key: nothing here reaches a chain.
const account = privateKeyToAccount(generatePrivateKey())
const config = { chain: base, explorer: 'https://basescan.org', maxFeePerGas: parseGwei('1') }
const TX = { to: '0x1111111111111111111111111111111111111111', data: '0x', gas: '100000' }

const rpcError = (text) => Object.assign(new Error(text), { shortMessage: text })
const networkError = () => new Error('fetch failed')

/** A stand-in RPC. `replies` are what each broadcast throws, in order; undefined means accepted. */
function fakeRpc({ replies = [], nonces = [7] }) {
  const broadcast = []
  return {
    broadcast,
    async getTransactionCount() {
      return nonces.length > 1 ? nonces.shift() : nonces[0]
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: parseGwei('0.01'), maxPriorityFeePerGas: parseGwei('0.001') }
    },
    async sendRawTransaction({ serializedTransaction }) {
      broadcast.push(keccak256(serializedTransaction))
      const reply = replies.shift()
      if (reply) throw reply
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: 'success', transactionHash: hash }
    },
  }
}

function sender(pub) {
  return new TxSender({ pub, account, config, log: () => {}, retryDelayMs: 0 })
}

describe('TxSender', () => {
  it('sends once and moves on to the next nonce', async () => {
    const pub = fakeRpc({})
    const s = sender(pub)
    const hashes = []
    const receipt = await s.send(TX, 'test', (hash) => hashes.push(hash))

    assert.equal(pub.broadcast.length, 1)
    assert.deepEqual(hashes, [receipt.transactionHash])
    assert.equal(s.nonce, 8)
  })

  it('never signs the call again once a broadcast may have gone out', async () => {
    // The first broadcast lands but its reply is lost; the retry hears "nonce too low" because it's mined.
    const pub = fakeRpc({ replies: [networkError(), rpcError('nonce too low')], nonces: [7, 8] })
    const hashes = []
    const receipt = await sender(pub).send(TX, 'test', (hash) => hashes.push(hash))

    assert.equal(new Set(pub.broadcast).size, 1, 'only one signed transaction was ever broadcast')
    assert.deepEqual(hashes, [receipt.transactionHash])
  })

  it('signs again with the next nonce when the node turned the first one down outright', async () => {
    // The nonce read at the start was stale: 7 was already used.
    const pub = fakeRpc({ replies: [rpcError('nonce too low')], nonces: [7, 8] })
    const s = sender(pub)
    const hashes = []
    const receipt = await s.send(TX, 'test', (hash) => hashes.push(hash))

    assert.equal(new Set(pub.broadcast).size, 2)
    assert.equal(hashes.length, 2)
    assert.equal(receipt.transactionHash, hashes[1])
    assert.equal(s.nonce, 9)
  })

  it("stops without guessing when it can't tell whether the transaction went out", async () => {
    const pub = fakeRpc({ replies: [networkError(), networkError(), networkError(), networkError()] })

    await assert.rejects(sender(pub).send(TX, 'test'), ReceiptTimeoutError)
    assert.equal(new Set(pub.broadcast).size, 1)
  })

  it('refuses a gas price over the cap before signing anything', async () => {
    const pub = fakeRpc({})
    pub.estimateFeesPerGas = async () => ({ maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') })

    await assert.rejects(sender(pub).send(TX, 'test'), (e) => e instanceof UserError && /BOPSTER_MAX_FEE_GWEI/.test(e.message))
    assert.equal(pub.broadcast.length, 0)
  })
})
