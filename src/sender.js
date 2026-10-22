import { formatGwei, keccak256 } from 'viem'

import { ReceiptTimeoutError, UserError } from './errors.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RECEIPT_TIMEOUT_MS = 180_000

/**
 * Signs locally and broadcasts one transaction at a time, waiting for each to confirm.
 *
 * The nonce is kept here instead of asked of the RPC before every send, because right after a
 * confirmation a load-balanced node may not have seen it yet. Each transaction is signed once and
 * its hash goes to `onHash` (to be saved) before it's broadcast. Resending the same signed bytes
 * after a network error can't run it twice. Signing it again with another nonce could, so that only
 * happens when the node turned the first one down outright.
 */
export class TxSender {
  constructor({ pub, account, config, log, retryDelayMs = 3_000 }) {
    this.pub = pub
    this.account = account
    this.config = config
    this.log = log
    this.retryDelayMs = retryDelayMs
    this.nonce = null
  }

  link(hash) {
    return `${this.config.explorer}/tx/${hash}`
  }

  async #fees() {
    const fees = await this.pub.estimateFeesPerGas()
    if (fees.maxFeePerGas > this.config.maxFeePerGas) {
      throw new UserError(
        `Gas is at ${formatGwei(fees.maxFeePerGas)} gwei, over BOPSTER_MAX_FEE_GWEI (${formatGwei(this.config.maxFeePerGas)}). Nothing sent.`,
      )
    }
    return fees
  }

  async #sign(tx, fees) {
    const serialized = await this.account.signTransaction({
      type: 'eip1559',
      chainId: this.config.chain.id,
      nonce: this.nonce,
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: BigInt(tx.gas),
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    return { serialized, hash: keccak256(serialized) }
  }

  /** Signs, broadcasts and waits. Throws if it reverts. `onHash` runs before the broadcast. */
  async send(tx, label, onHash = () => {}) {
    if (this.nonce === null) {
      this.nonce = await this.pub.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
    }
    const fees = await this.#fees()
    let signed = await this.#sign(tx, fees)
    await onHash(signed.hash)

    // Set once a broadcast fails without a clear answer: from then on the transaction may be out.
    let maybeSent = false
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pub.sendRawTransaction({ serializedTransaction: signed.serialized })
        break
      } catch (error) {
        const message = `${error.shortMessage ?? ''} ${error.details ?? ''} ${error.message ?? ''}`
        const reason = error.shortMessage ?? error.message
        if (/already known|known transaction|alreadyknown/i.test(message)) break
        if (/insufficient funds/i.test(message)) throw new UserError(`${label}: the wallet doesn't have enough ETH for gas.`)
        if (/replacement|underpriced/i.test(message)) {
          throw new UserError(`${label}: another transaction from this wallet is pending with the same nonce. Wait for it to confirm, then run the command again.`)
        }
        const nonceTooLow = /nonce too low|nonce.*(used|expired)/i.test(message)
        // Probably ours from an earlier attempt. Wait for it below rather than sign a second one.
        if (nonceTooLow && maybeSent) break
        if (!nonceTooLow) maybeSent = true
        if (attempt >= 4) {
          if (maybeSent) {
            throw new ReceiptTimeoutError(
              `${label}: couldn't tell whether it was sent (${reason}). Check ${this.link(signed.hash)} before running the command again.`,
            )
          }
          throw new UserError(`${label}: couldn't send it (${reason}).`)
        }
        if (nonceTooLow) {
          // Turned down before any node took it, so the nonce read at the start was stale.
          const pending = await this.pub.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
          if (pending > this.nonce) {
            this.nonce = pending
            signed = await this.#sign(tx, fees)
            await onHash(signed.hash)
          }
        }
        this.log(`      ${label}: sending again (${attempt})`)
        await sleep(this.retryDelayMs)
      }
    }
    const receipt = await this.receipt(signed.hash, label)
    // Mined, reverted or not, the nonce is spent.
    this.nonce += 1
    return this.#confirmed(receipt, label)
  }

  /** Waits for a transaction already sent, this run or an earlier one. Throws if it reverted. */
  async waitFor(hash, label) {
    return this.#confirmed(await this.receipt(hash, label), label)
  }

  /** The receipt of a sent transaction, reverted or not. Throws only if it doesn't confirm in time. */
  async receipt(hash, label) {
    try {
      return await this.pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
    } catch {
      throw new ReceiptTimeoutError(
        `${label}: ${hash} hasn't confirmed in ${RECEIPT_TIMEOUT_MS / 60_000} minutes. Check ${this.link(hash)} and run the command again once it confirms.`,
      )
    }
  }

  #confirmed(receipt, label) {
    if (receipt.status !== 'success') throw new UserError(`${label}: the transaction reverted on chain: ${this.link(receipt.transactionHash)}`)
    this.log(`      ✓ ${label}: ${this.link(receipt.transactionHash)}`)
    return receipt
  }
}
