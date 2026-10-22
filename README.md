<p>
  <img src="bopster-logo-mini.png" alt="Bopster Fun" width="200" />
</p>

# Bopster CLI

**Create markets, take positions and claim on [Bopster](https://bopster.fun) from the command line.**
Signs locally with your own key, on Base mainnet.

[![test](https://github.com/marcosroigdev/bopster-cli/actions/workflows/test.yml/badge.svg)](https://github.com/marcosroigdev/bopster-cli/actions/workflows/test.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22.9-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

> **Real funds.** Every command that sends a transaction spends USDC and ETH from
> your wallet on Base mainnet. Use a wallet that only holds what you plan to use,
> and check that prediction markets are allowed where you live.

---

## How it works

The [Bopster MCP](https://github.com/marcosroigdev/bopster-mcp) server (`https://mcp.bopster.fun/mcp`) prepares Bopster transactions
but never signs them. This CLI asks the MCP for each transaction, checks it against
the chain, signs it with your key and sends it, one at a time, waiting for each one
to confirm.

```
plan (JSON) -> Bopster MCP -> unsigned transactions -> checks -> signed with your key -> Base
```

The key never leaves your machine, and the CLI checks everything the MCP sends
before signing it. It reads the USDC and Reality.eth addresses from the Bopster
factory itself and refuses anything that doesn't match:

| Transaction | What has to match |
|---|---|
| Login message | Bopster's login message for your wallet, and nothing else |
| `askQuestion` | The factory's Reality.eth, template 0, the exact question you confirmed, Bopster's arbitrator and answer window, and the plan's resolve time (close plus delay) as opening time |
| `createMarket` | The factory, the question you just asked, and the times and metadata of the draft |
| `approve` + position | The factory's USDC, the exact amount, approved to that market; the position on the side and for the amount you asked for; the market has to be in the factory's registry |
| `finalize`, `claim`, `claimRefund` | Calls without arguments to that market, with the claim last |

On every transaction: no ETH attached, a gas limit within range, and a gas price
under `BOPSTER_MAX_FEE_GWEI`. On top of that, stake caps per side and per market
(see [Configuration](#configuration)), and a confirmation before anything is sent.

The question text itself comes from the MCP. You see it before confirming, and
positions are only taken once the backend scores the market `high_trust`, which
it only does when the question matches the template.

---

## Quickstart

Requires **Node.js >= 22.9** on macOS or Linux. On Windows, use WSL.

```bash
git clone https://github.com/marcosroigdev/bopster-cli.git
cd bopster-cli
npm ci
cp .env.example .env
```

Set `BOPSTER_WALLET` in `.env` to your wallet address, then store the key.

### Storing the key

The key lives outside the repo, in a file only your user can read. The CLI never
prints it or copies it anywhere, and refuses to use it if the file is readable by
other users or if it belongs to a wallet other than `BOPSTER_WALLET`.

Copy the private key from your wallet (in MetaMask: account menu -> *Account details*
-> *Show private key*) and save it without it going through your shell history. On
macOS:

```bash
mkdir -p ~/.bopster && chmod 700 ~/.bopster
pbpaste > ~/.bopster/private-key && chmod 600 ~/.bopster/private-key && pbcopy < /dev/null
```

On Linux, use `wl-paste` or `xclip -selection clipboard -o` instead of `pbpaste`.

Then check the setup. It should print `Key: OK ... (matches BOPSTER_WALLET)`:

```bash
npm run bop -- check
```

---

## Usage

| Command | What it does |
|---|---|
| `npm run bop -- check` | Config, key, balances, backend and fees. Sends nothing. |
| `npm run bop -- validate <plan.json>` | Checks plans locally: shape, dates and caps. No network, no key. |
| `npm run bop -- create <plan.json>` | Creates the market in each plan and takes the plan's positions. |
| `npm run bop -- position <market> <YES\|NO> <USDC>` | One position on a market that already exists. Shows what you hold and what it would pay first. |
| `npm run bop -- status` | Your positions in every Bopster market, read from the chain, and what each one can claim. Sends nothing and doesn't need the key. |
| `npm run bop -- claim [market]` | Claims every payout and refund waiting for you, or only the one for that market. A market that is ready but not settled yet gets `finalize()` first, which also pays you the resolver reward (0.2% of the pool with the current factory fees). |

Options:

- `--yes` - skip the confirmation.
- `--allow-low-trust` - with `create`, take positions even if the backend scores the market below `high_trust`.

### Creating a market

```bash
npm run bop -- validate plans/20261020-btc-150k.json
npm run bop -- create plans/20261020-btc-150k.json
```

`create` goes through these steps:

1. Logs in to the backend by signing Bopster's login message.
2. Asks the MCP to draft the question from the template. The MCP checks the template and pins the metadata to IPFS.
3. Shows the exact question, the times, the positions and your balances, and waits for your confirmation.
4. Sends `askQuestion` and then `createMarket`, and registers the market with the backend.
5. If the plan has positions, it waits for the backend to show the market. If it isn't there yet, or it's scored below `high_trust`, it stops before the positions.
6. Sends approve + YES position, then approve + NO position.

Several plans can go in one command: `create plans/a.json plans/b.json`.

If a run stops halfway (network error, Ctrl-C, laptop closed), running the same
command again picks it up where it stopped. Every step is saved in
`runs/<plan>.json`, so running it again doesn't ask a second question or take a
position twice. If the CLI can't tell whether a transaction went out, it stops and
asks you to check the explorer instead of sending it again. A finished plan isn't
created again; for a similar market, copy the plan under a new name.

The CLI doesn't answer the question on Reality.eth. After the resolve time, anyone
can answer it there by posting a bond, anyone can dispute with a higher bond, and
the arbitrator decides if it gets that far.

---

## Plans

One JSON file per market. [`plans/examples/`](plans/examples/) has one per template,
with placeholder dates: set your own before launching one. Plans you write in
`plans/` stay out of git.

```json
{
  "title": "BTC above $150K on Oct 20",
  "category": "Crypto",
  "template": { "type": "price_threshold", "asset": "BTC", "direction": "above", "price": "150000" },
  "source_url": "https://www.coingecko.com/en/coins/bitcoin",
  "end_time": "2026-10-20T18:00:00Z",
  "resolution_delay_minutes": 30,
  "accept_terms": true,
  "positions": { "yes": "5", "no": "5" }
}
```

| Field | Rules |
|---|---|
| `template` | One of the five templates on bopster.fun. Free-text questions aren't accepted; the MCP words the question exactly as the site does. |
| `end_time` | When positions close. ISO 8601 with a timezone, on a whole minute, between 20 minutes and 10 days from launch. For a match, the kick-off. |
| `resolution_delay_minutes` | Time between the close and the moment the oracle accepts answers: 15, 30, 60, 120, 180, 210, 240, 300, 360, 720, 1440, 2880, 4320, 5760 or 7200. Default 30. |
| `category` | One of the site's categories: Crypto, Tech, Internet, Business, Entertainment, Sports, Culture, Politics, Science or General. Other names are accepted, but the site can't filter by them. |
| `sports_match` | Required in Sports: `football`, `football-knockout`, `basketball`, `ice-hockey`, `rugby`, `american-football-baseball`, `formula-1`, `other` or `not_a_match`. For a match, the sport sets the resolution delay. |
| `source_url` | Public page where the result will be published. |
| `accept_terms` | Must be `true`: creating a market accepts the Bopster Fun Terms of Use, same as on the site. |
| `positions` | USDC on each side. Leave out one side, or both to create the market without positions. |
| `notes` | Free text for yourself. Never sent. |

Template fields:

- `price_threshold`: `asset` (ticker, up to 4 letters or digits), `direction` (`above` or `below`) and `price` (a positive number such as `90000` or `0.85`, 12 characters at most).
- `event_outcome`: `event` (8 to 180 characters, verb in its base form, without "Will" or "?").
- `before_date`: `subject` and `action` (8 to 90 characters each).
- `price_change`: `asset`, `direction` (`up` or `down`) and `percentage` (above 0, at most 100).
- `compare_assets`: `asset_a`, `direction` (`higher` or `lower`) and `asset_b` (different from `asset_a`).

`validate` only checks the shape, the dates and the caps. The MCP applies the
site's template rules when you run `create`, before anything is signed, and says
what's wrong if something doesn't fit.

---

## Configuration

All settings go in `.env` (see [`.env.example`](.env.example)).

| Variable | Default | |
|---|---|---|
| `BOPSTER_WALLET` | - | Your wallet. A key for any other wallet is refused. |
| `BOPSTER_KEY_FILE` | `~/.bopster/private-key` | Path to the private key. |
| `BOPSTER_MAX_STAKE_PER_SIDE` | 50 | Max USDC your wallet can hold on one side of a market. |
| `BOPSTER_MAX_STAKE_PER_MARKET` | 100 | Max USDC your wallet can hold in one market, both sides together. |
| `BOPSTER_MIN_ETH` | 0.0003 | Minimum ETH balance for gas before starting. |
| `BOPSTER_MAX_FEE_GWEI` | 1 | Nothing is sent above this gas price. Base is usually around 0.01. |
| `BOPSTER_RPC_URL` | `https://mainnet.base.org` | Base RPC. The public one is free but rate-limited. |
| `BOPSTER_MCP_URL` | `https://mcp.bopster.fun/mcp` | MCP server. |
| `BOPSTER_NETWORK` | `base` | `base-sepolia` to test against a local MCP and backend. |
| `BOPSTER_RUNS_DIR` | `runs/` | Where `create` saves the progress of each plan. |

---

## Using it with an AI agent

The CLI works the same whether you or a coding agent writes the plans.
[`AGENTS.md`](AGENTS.md) sets the rules for agents working in this repo: they can
write and validate plans, run the tests, `check` and `status`, and use the MCP's
read tools, but `create`, `position` and `claim` are left to you, and the key is
off limits.

To run it unattended, `--yes` skips the confirmation and the caps in `.env` become
the only limit, so keep the wallet's balance low.

If you'd rather sign some other way, the MCP at `https://mcp.bopster.fun/mcp` works
with any MCP client and returns unsigned transactions for any wallet.

---

## Tests

```bash
npm test
```

Unit tests for the transaction checks, the plans and the key handling.

```bash
npm run e2e:fork
```

The full cycle on an anvil fork of Base mainnet (needs [Foundry](https://getfoundry.sh/)),
with a test wallet and a local stand-in for the backend, through the
[bopster-mcp](https://github.com/marcosroigdev/bopster-mcp) source checked out next to this repo, with
`pnpm install` run in it (`BOPSTER_MCP_DIR` to point elsewhere). It
covers `check`, creating a market with positions, re-running a finished plan, a
single position, the refusals (caps, missing confirmation, an MCP that asks with
another arbitrator), a `create` interrupted twice and resumed, and the oracle
answering followed by `status` and `claim`. It doesn't touch the real chain or
the real backend.

---

## Repository structure

```
bopster-cli/
  src/
    cli.js            # command line entry point
    commands/         # check, validate, create, position, status/claim
    guard.js          # checks on every transaction before signing
    sender.js         # signing, nonces, sending and receipts
    plan.js           # plan validation
    mcp.js            # MCP client and login
    chain.js          # on-chain reads
  plans/examples/     # one example plan per template
  scripts/e2e-fork.mjs
  test/
```

---

## License

MIT. See [LICENSE](LICENSE).

## Security

For vulnerability disclosure, see [SECURITY.md](SECURITY.md).
Don't open a public issue for security reports.
