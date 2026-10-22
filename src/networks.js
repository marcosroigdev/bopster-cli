import { base, baseSepolia } from 'viem/chains'

/**
 * Where the CLI runs. The USDC token and the Reality.eth contract are not listed here: they are read
 * from the factory itself, so they can't drift from what the markets actually use.
 */
export const NETWORKS = {
  base: {
    chain: base,
    mcpUrl: 'https://mcp.bopster.fun/mcp',
    rpcUrl: 'https://mainnet.base.org',
    factory: '0x11a2a549286567f7427d990423e5a3560ea16750',
    // Bopster's arbitrator and answer window: what the backend needs to score a market high_trust.
    arbitrator: '0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6',
    realityTimeoutSeconds: 43_200,
    explorer: 'https://basescan.org',
  },
  // For trying changes against a local bopster-mcp and backend on Base Sepolia.
  'base-sepolia': {
    chain: baseSepolia,
    mcpUrl: 'http://127.0.0.1:8788/mcp',
    rpcUrl: 'https://sepolia.base.org',
    factory: '0xE1B44fF6caA349A4f77271a372cda7454146D673',
    arbitrator: '0xFB0D534131a38A3Be787Ed143e1028b61Bc3f7c9',
    realityTimeoutSeconds: 43_200,
    explorer: 'https://sepolia.basescan.org',
  },
}
