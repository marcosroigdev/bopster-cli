/** A problem the operator can fix: printed as is, without a stack trace. */
export class UserError extends Error {}

/** A prepared transaction that doesn't match what the operator asked for. Nothing is sent. */
export class GuardError extends UserError {}

/** A sent transaction that hasn't confirmed: its nonce may still be pending, so nothing else is sent. */
export class ReceiptTimeoutError extends UserError {}
