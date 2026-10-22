# AGENTS.md

Rules for coding agents working in this repo. The README has the full
documentation.

## What this repo is

A CLI that signs the transactions prepared by the Bopster MCP (create markets,
take positions, claim) with the operator's wallet, on Base mainnet, with real funds.

## What an agent can and can't do

Allowed:

- Write and review plans in `plans/`.
- Run `npm test`, `npm run e2e:fork`, `npm run bop -- validate`, `npm run bop -- check` and `npm run bop -- status`.
- Use the MCP's read tools (`list_markets`, `get_market`, `quote_position`, etc.) to prepare a plan.

Not allowed:

- Running `create`, `position` or `claim`. They spend or move the operator's funds, so the operator runs them.
- Reading, printing or copying the key (`~/.bopster/private-key` or `BOPSTER_KEY_FILE`).

## Writing a plan

- Path: `plans/<YYYYMMDD>-<slug>.json`, dated by the close. One market per file. Fields and rules are in the README ("Plans"), and `plans/examples/` has one plan per template.
- Only the five templates (`price_threshold`, `event_outcome`, `before_date`, `price_change`, `compare_assets`). If the request doesn't fit any of them, say so instead of forcing one.
- `end_time`: UTC with `Z`, on a whole minute, between 20 minutes and 10 days from when the operator will launch it. For a Sports match, the kick-off, with `sports_match` and without `resolution_delay_minutes`.
- `resolution_delay_minutes`: long enough for the result to exist and be published at `source_url`.
- `source_url`: a specific public page that will show the result.
- `positions`: the amounts the operator asks for. If they don't give any, ask. Stay within the caps in `.env`. Leave the field out to create the market without positions.
- `accept_terms: true` only once the operator has asked for the market to be created.
- `title`: short, like the cards on the site (e.g. "BTC above $150K on Oct 20").
- Run `npm run bop -- validate plans/X.json` (it sends nothing). The MCP applies the remaining rules when the operator launches the plan.
- When done, give the operator the exact command (`npm run bop -- create plans/X.json`) and what they'll see before confirming.
- Wording in plans and messages: position, side, stake. Not bet, wager, gamble or odds.

## Changing the code

- Every transaction goes through `src/guard.js` before it's signed. If the MCP starts preparing something new, extend the guard and its tests; never bypass it.
- `npm test` has to pass, and `npm run e2e:fork` too if you have the bopster-mcp source next to this repo.
- Messages and comments in English.
