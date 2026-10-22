// The whole cycle on an anvil fork of Base mainnet, through a real bopster-mcp and this
// CLI, with a throwaway anvil wallet: create a market, both positions, the oracle answers, settle,
// claim. Plus the refusals: over the caps, without confirmation, and an MCP that prepares a
// question with the wrong arbitrator. Nothing touches the real chain or the real backend: the MCP
// talks to a stand-in backend started here.
//
//   npm run e2e:fork        (needs anvil, and bopster-mcp checked out next to this repo with its
//                            dependencies installed; BOPSTER_MCP_DIR to point elsewhere)
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestClient, encodeAbiParameters, http, keccak256, pad, publicActions, toHex, walletActions } from 'viem'
import { base } from 'viem/chains'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MCP_DIR = process.env.BOPSTER_MCP_DIR ?? join(ROOT, '..', 'bopster-mcp')
const FORK_SOURCE = process.env.FORK_URL ?? 'https://mainnet.base.org'
const FORK_PORT = 8546
const BACKEND_PORT = 8799
const MCP_PORT = 8798
const BAD_MCP_PORT = 8797
const FORK = `http://127.0.0.1:${FORK_PORT}`

const FACTORY = '0x11a2a549286567f7427d990423e5a3560ea16750'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ARBITRATOR = '0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6'
// anvil's well-known test accounts #3 (plays the operator) and #4 (answers the oracle). Public keys, no real funds.
const OPERATOR_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
const OPERATOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const ANSWERER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'

const realityAbi = [
  { type: 'function', name: 'submitAnswer', stateMutability: 'payable', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'isFinalized', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
]
const marketAbi = [
  { type: 'function', name: 'yesPosition', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'noPosition', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimed', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'reality', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const factoryAbi = [{ type: 'function', name: 'marketsCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }]
const erc20Abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  - ${detail}` : ''}`)
  if (!ok) failures++
}

const children = []
process.on('exit', () => children.forEach((child) => child.kill('SIGKILL')))
function start(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.stderrText = () => stderr
  children.push(child)
  return child
}
async function waitFor(label, probe, child) {
  for (let i = 0; i < 60; i++) {
    if (child?.exitCode != null) throw new Error(`${label} exited:\n${child.stderrText()}`)
    if (await probe().catch(() => false)) return
    await sleep(500)
  }
  throw new Error(`${label} did not start:\n${child?.stderrText() ?? ''}`)
}

// --- The fork ------------------------------------------------------------------------------------
// Base's own base fee, about 0.005 gwei, instead of anvil's 1 gwei.
const anvil = start('anvil', ['--fork-url', FORK_SOURCE, '--port', String(FORK_PORT), '--silent', '--block-base-fee-per-gas', '5000000'])
const t = createTestClient({ chain: base, mode: 'anvil', transport: http(FORK) }).extend(publicActions).extend(walletActions)
await waitFor('anvil', async () => (await t.getChainId()) === 8453, anvil)

const usdcSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [OPERATOR, 9n]))
await t.setStorageAt({ address: USDC, index: usdcSlot, value: pad(toHex(200_000_000n)) })
const usdcOf = (who) => t.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
const nonce = () => t.getTransactionCount({ address: OPERATOR })
check('fork up, the test wallet holds 200 USDC', (await usdcOf(OPERATOR)) === 200_000_000n)

// --- A stand-in backend: just what the MCP asks of it, and a record of what it was told --------------
const told = []
const backend = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    told.push(`${req.method} ${url.pathname}`)
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status < 400 ? { data } : { errors: [{ code: 'not_found', message: 'Not found', context: {} }] }))
    }
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /health') return reply(200, { status: 'ok' })
    if (route === 'GET /auth/wallet/nonce') return reply(200, { nonce: `n${Date.now()}`, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    if (route === 'POST /auth/wallet/login') return reply(200, { access_token: 'fork-session' })
    if (route.startsWith('GET /user-view/')) return reply(200, { profile: { alias: 'fork-tester' } })
    if (route === 'POST /ipfs/metadata') return reply(201, { cid: 'bafkreiforktest', metadataUri: 'ipfs://bafkreiforktest' })
    if (route === 'POST /market') return reply(201, [])
    if (route.startsWith('PUT /market/')) return reply(200, [])
    if (route.startsWith('GET /market-view/')) return reply(200, { quality_tier: 'high_trust', quality_score: 100 })
    return reply(404)
  })
})
await new Promise((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve))

// --- bopster-mcp from its source, on the fork: one right, one with someone else's arbitrator ----------
function startMcp(port, arbitrator) {
  const mcp = start(process.execPath, ['--import', 'tsx', 'src/bin/http.ts'], {
    cwd: MCP_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MCP_PORT: String(port),
      BOPSTER_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      BOPSTER_CHAIN_ID: '8453',
      BOPSTER_RPC_URL: FORK,
      BOPSTER_FACTORY_ADDRESS: FACTORY,
      BOPSTER_REALITY_ARBITRATOR: arbitrator,
      BOPSTER_REALITY_TIMEOUT_SECONDS: '43200',
    },
  })
  return waitFor(`bopster-mcp :${port}`, async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, mcp)
}
await startMcp(MCP_PORT, ARBITRATOR)
await startMcp(BAD_MCP_PORT, '0x000000000000000000000000000000000000bEEF')

// --- The CLI, as the operator runs it ----------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'bopster-cli-e2e-'))
const keyFile = join(work, 'private-key')
writeFileSync(keyFile, OPERATOR_KEY)
chmodSync(keyFile, 0o600)

function cliEnv(mcpPort) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    BOPSTER_NETWORK: 'base',
    BOPSTER_RPC_URL: FORK,
    BOPSTER_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
    BOPSTER_KEY_FILE: keyFile,
    BOPSTER_WALLET: OPERATOR,
    BOPSTER_RUNS_DIR: join(work, 'runs'),
    // anvil suggests a 1 gwei priority fee where Base suggests 0.001, so the default 1 gwei cap
    // would refuse everything here.
    BOPSTER_MAX_FEE_GWEI: '2',
  }
}

function cli(args, { mcpPort = MCP_PORT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'src/cli.js'), ...args], {
      env: cliEnv(mcpPort),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      console.log(out.replace(/^/gm, '      | ').trimEnd())
      resolve({ code, out })
    })
  })
}

/** Runs the CLI and kills it (SIGKILL: no cleanup) as soon as it prints `marker`: a crash mid-way. */
function cliKilledAfter(args, marker) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'src/cli.js'), ...args], { env: cliEnv(MCP_PORT), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
      if (out.includes(marker)) child.kill('SIGKILL')
    })
    child.on('close', () => {
      console.log(`${out.replace(/^/gm, '      | ').trimEnd()}\n      | (killed)`)
      resolve(out)
    })
  })
}

function writePlan(name, minutesAhead) {
  const end = Math.ceil((Date.now() + minutesAhead * 60_000) / 60_000) * 60
  const path = join(work, `${name}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      title: 'Fork test: BTC above $1000',
      category: 'Crypto',
      template: { type: 'price_threshold', asset: 'BTC', direction: 'above', price: '1000' },
      source_url: 'https://www.coingecko.com/en/coins/bitcoin',
      end_time: new Date(end * 1000).toISOString(),
      resolution_delay_minutes: 15,
      accept_terms: true,
      positions: { yes: '5', no: '3' },
    }),
  )
  return { path, end }
}

try {
  console.log('\n== check')
  let r = await cli(['check'])
  check('check passes against the fork and the MCP', r.code === 0 && r.out.includes('same factory'))

  console.log('\n== create: question, market, YES 5 and NO 3')
  const plan = writePlan('fork-btc', 40)
  r = await cli(['create', plan.path, '--yes'])
  const run = JSON.parse(readFileSync(join(work, 'runs', 'fork-btc.json'), 'utf8'))
  check('create finishes and records every step', r.code === 0 && run.done === true && Boolean(run.market))
  if (!run.done) throw new Error('create did not finish; the rest needs its market')
  const market = run.market
  const read = (fn) => t.readContract({ address: market, abi: marketAbi, functionName: fn, args: [OPERATOR] })
  check('on chain: YES 5 and NO 3 from the test wallet', (await read('yesPosition')) === 5_000_000n && (await read('noPosition')) === 3_000_000n)
  check('the backend was told about the market and synced', told.includes('POST /market') && told.some((x) => x.startsWith('PUT /market/')))

  console.log('\n== create the same plan again')
  let before = await nonce()
  r = await cli(['create', plan.path, '--yes'])
  check('a finished plan is not created twice', r.code === 0 && r.out.includes('Already created') && (await nonce()) === before)

  console.log('\n== position: one more YES 1')
  r = await cli(['position', market, 'YES', '1', '--yes'])
  check('position adds YES 1', r.code === 0 && (await read('yesPosition')) === 6_000_000n)

  console.log('\n== refusals')
  before = await nonce()
  r = await cli(['position', market, 'YES', '51', '--yes'])
  check('over the per-side cap: refused', r.code === 1 && r.out.includes('PER_SIDE'))
  r = await cli(['position', market, 'YES', '45', '--yes'])
  check('the per-side cap counts what the wallet already holds: refused', r.code === 1 && r.out.includes('on YES here'))
  r = await cli(['position', market, 'NO', '1'])
  check('without a terminal and without --yes: refused', r.code === 1 && r.out.includes('confirmation'))
  const badPlan = writePlan('fork-bad-arbitrator', 40)
  r = await cli(['create', badPlan.path, '--yes'], { mcpPort: BAD_MCP_PORT })
  check("an MCP asking with someone else's arbitrator: refused before signing", r.code === 1 && r.out.includes('arbitrator'))
  check('none of the refusals sent a transaction', (await nonce()) === before)

  console.log('\n== a create cut off twice, then run again until done')
  const count = () => t.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'marketsCount' })
  const marketsBefore = await count()
  const resumePlan = writePlan('fork-resume', 40)
  await cliKilledAfter(['create', resumePlan.path, '--yes'], '✓ askQuestion')
  await cliKilledAfter(['create', resumePlan.path, '--yes'], '✓ approve 5 USDC for YES')
  r = await cli(['create', resumePlan.path, '--yes'])
  const resumed = JSON.parse(readFileSync(join(work, 'runs', 'fork-resume.json'), 'utf8'))
  const readResumed = (fn) => t.readContract({ address: resumed.market, abi: marketAbi, functionName: fn, args: [OPERATOR] })
  check('after two crashes, the run finishes', r.code === 0 && resumed.done === true)
  check('with one market, not two', (await count()) === marketsBefore + 1n, `${(await count()) - marketsBefore} created`)
  check('and each position once: YES 5, NO 3', (await readResumed('yesPosition')) === 5_000_000n && (await readResumed('noPosition')) === 3_000_000n)

  console.log('\n== status before the outcome')
  r = await cli(['status'])
  check('status shows the market, nothing to claim yet', r.code === 0 && r.out.includes('not yet'))

  console.log('\n== the oracle answers YES and the answer becomes final')
  const reality = await t.readContract({ address: market, abi: marketAbi, functionName: 'reality' })
  const resolve = run.draft.resolve_time
  const now = Number((await t.getBlock()).timestamp)
  await t.increaseTime({ seconds: resolve - now + 60 })
  await t.mine({ blocks: 1 })
  const answer = await t.writeContract({ account: ANSWERER, address: reality, abi: realityAbi, functionName: 'submitAnswer', args: [run.questionId, pad(toHex(1n)), 0n], value: 1n })
  await t.waitForTransactionReceipt({ hash: answer })
  await t.increaseTime({ seconds: 43_201 })
  await t.mine({ blocks: 1 })
  check('Reality.eth answer is final', await t.readContract({ address: reality, abi: realityAbi, functionName: 'isFinalized', args: [run.questionId] }))

  console.log('\n== status and claim')
  r = await cli(['status'])
  check('status sees a payout to claim', r.code === 0 && r.out.includes('payout'))
  const usdcBefore = await usdcOf(OPERATOR)
  r = await cli(['claim', '--yes'])
  const gained = (await usdcOf(OPERATOR)) - usdcBefore
  check('claim settles the market and pays the wallet', r.code === 0 && (await read('claimed')) === true, `received ${Number(gained) / 1e6} USDC`)
  r = await cli(['claim', '--yes'])
  check('nothing left to claim afterwards', r.code === 0 && r.out.includes('Nothing to claim'))
} catch (error) {
  failures++
  console.log(`\nSTOPPED: ${error.stack ?? error.message}`)
} finally {
  backend.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures ? 1 : 0)
