# Security Policy

## Reporting a vulnerability

Don't open a public issue, pull request or discussion for a vulnerability.
Use GitHub's private vulnerability reporting instead:

1. Go to <https://github.com/marcosroigdev/bopster-cli/security/advisories/new>
   (or **Security -> Advisories -> "Report a vulnerability"** in the repo header).
2. Describe the issue, how to reproduce it and its impact.
3. Submit. The report stays visible only to the maintainer and to you until
   the advisory is published.

Never include a private key or a seed phrase in a report.

## Scope

### In scope

- Anything that gets the CLI to sign or send a transaction the operator didn't
  ask for, or to skip a check in `src/guard.js`.
- Anything that exposes the private key: logs, error messages or files written
  by the CLI.
- Ways to make one plan create a second market or take a position twice.

### Out of scope

- The Bopster contracts. Report those in
  [bopster-market-contract](https://github.com/marcosroigdev/bopster-market-contract/security).
- Losses caused by a compromised machine or a leaked key.
