# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Build & Test

```bash
forge build
forge test
```

## Architecture Overview

HyperEVM outcome composability layer: wraps HIP-4 binary outcome markets as ERC-20s (oYES/oNO) via CoreWriter split/merge. Design spec: `~/docs/superpowers/specs/2026-08-12-hyperevm-outcome-composability-design.md`.

- `src/CoreConstants.sol` — HyperCore interop constants and payload encoding (UNVERIFIED values patched by testnet spike)
- `src/OutcomeToken.sol` — vault-gated ERC-20 for one outcome side
- `src/OutcomeVault.sol` — per-market vault: deposit/split, pair redemption, settlement
- `test/anchor/Anchor.t.sol` — definition-of-done tests; do not edit
- `test/CoreSim.sol` — simulated HyperCore for tests
