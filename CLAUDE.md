# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Build & Test

```bash
forge build
forge test
```

## Knowledge base

Project history, architecture, decisions, operational facts, release records and known gotchas
live in the Obsidian vault at `~/Library/CloudStorage/GoogleDrive-biljeskovic.lovro@gmail.com/My Drive/Hyperflip` (start at `00 Index.md`).
**Read the matching note before re-deriving any of that**, and treat notes as point-in-time —
verify file:line claims against the code.

Keep it current as part of finishing work, the same way you write a memory one-liner:

- Update `Roadmap/Current State.md` first, then the note the work touched — a new gotcha into
  `Gotchas.md`, a new choice into `Decisions/Decision Log.md`, a deploy into
  `Operations/Release History.md`.
- After writing a new spec or plan, run `bash "$HOME/Library/CloudStorage/GoogleDrive-biljeskovic.lovro@gmail.com/My Drive/Hyperflip/kb-sync.sh"`
  to refresh the verbatim `Archive/`.

## Architecture Overview

HyperEVM outcome composability layer: wraps HIP-4 binary outcome markets as ERC-20s (oYES/oNO) via CoreWriter split/merge. Design spec: `~/docs/superpowers/specs/2026-08-12-hyperevm-outcome-composability-design.md`.

- `src/CoreConstants.sol` — HyperCore interop constants and payload encoding (values verified by the 2026-08 testnet spike, see `docs/spike-findings.md`)
- `src/OutcomeToken.sol` — vault-gated ERC-20 for one outcome side
- `src/OutcomeVault.sol` — per-market vault: deposit/split, pair redemption, settlement
- `test/anchor/Anchor.t.sol` — definition-of-done tests; do not edit
- `test/CoreSim.sol` — simulated HyperCore for tests
- `writer/` — house writer service: prices parlay premiums off the Core book, signs EIP-712 quotes, enforces exposure caps, pokes dead parlays (`cd writer && npm run check`)
