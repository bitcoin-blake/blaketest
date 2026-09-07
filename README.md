# blaketest

A client-side taproot wallet for the **Bitcoin BLAKE2b chain on testnet4**. Keys never leave the browser. Spends sign with the unified opt-in sighash, so they cannot be replayed onto the SHA256d chain.

Live: https://bitcoin-blake.github.io/blaketest/

**Testnet4 only.** Coins have no value. Never paste a mainnet key into this wallet. If you want a mainnet wallet for the chain, use the [Sparrow BLAKE2b build](https://github.com/paulscode/sparrow/releases) or [Shrike](https://github.com/privkeyio/shrike).

## What it does

- Generates or imports a key (hex, Nostr nsec, or WIF). The x-only public key is used directly as the taproot witness program, so the `tb1p` address and the Nostr npub are the same key.
- Shows balance and history, sends to `tb1q`, `tb1p` and P2WSH addresses, with RBF on.
- Signs every input with `SIGHASH_ALL | SIGHASH_UNIFIED` (0x21), the replay-protection sighash shipped in Bitcoin Knots `v29.4.1.knots20260508` ([PR #357](https://github.com/bitcoinknots/bitcoin/pull/357)). Testnet4 activated it at block 150,308.
- Talks to an Esplora-style API. Default is `https://mempool.guide/testnet4/api`.

## Getting test coins

Your address is the same on both testnet4 chains. Request coins from a SHA256d testnet4 faucet such as [faucet.activetk.jp](https://faucet.activetk.jp/), then use **Check SHA256d testnet4 for coins to carry across** on the wallet's home tab. Faucet payouts are signed with plain `SIGHASH_ALL`, so the same bytes are valid on the BLAKE2b chain; the wallet fetches the raw transaction from mempool.space and relays it to the BLAKE2b backend. It signs nothing. This only works while the faucet's coin lineage exists on both chains.

## Pointing it at your own node

Append `?api=<base>` once and it is remembered in localStorage:

```
https://bitcoin-blake.github.io/blaketest/?api=http://localhost:3006/api
https://bitcoin-blake.github.io/blaketest/?api=reset
```

The base must serve the Esplora endpoints the wallet uses: `address/:a`, `address/:a/txs`, `address/:a/utxo`, `v1/fees/recommended`, and `POST tx`. A mempool or electrs instance behind a Knots 29.4.1 testnet4 node does. Explorer links are the base with `/api` stripped.

## Running your own backend

mempool.guide's testnet4 follows a dead release-candidate chain, so a real backend means your own Knots 29.4.1 testnet4 node. `shim/server.mjs` is a small Esplora-shaped HTTP server over a [jasonsopko/electrs](https://github.com/jasonsopko/electrs) (`blake2b` branch) instance plus Knots RPC:

```
# electrs: clone -b blake2b, then (RocksDB needs cstdint on new toolchains)
CC=clang CXX=clang++ CXXFLAGS="-include cstdint" cargo build --locked --release
./target/release/electrs --conf config.toml     # network = "testnet4", daemon_rpc_addr = 127.0.0.1:48342

# shim
npm install
node shim/server.mjs --port 3006 --electrum 127.0.0.1:50001 --rpc 127.0.0.1:48342 --cookie ~/.bitcoin/testnet4/.cookie
```

Then open the wallet with `?api=http://127.0.0.1:3006/api`. Browsers allow an https page to call `http://127.0.0.1`, so the hosted wallet works against a local shim. The shim serves `address/:a`, `address/:a/utxo`, `address/:a/txs`, `tx/:id`, `v1/fees/recommended`, `blocks/tip/height` and `POST tx`, with open CORS and no auth. Testnet only, keep it on localhost or behind a proxy.

## Files

- `index.html` — the wallet. Preact plus htm, no build step, dependencies from esm.sh via an import map.
- `bitcoin.js` — keys, bech32m, taproot addresses, transaction building and signing.
- `unified.js` — the unified sighash message for all four script types, plus a raw transaction parser.
- `unified-sighash.md`, `unified_sighash.json` — the spec and the 166 test vectors, copied verbatim from the Knots tag.
- `test.mjs` — runs every vector and a build, sign, verify round trip.
- `shim/server.mjs` — Esplora-lite over electrs and Knots RPC, see above.

## Test

```
npm install
npm test
```

## Origin

Derived from [testcoin.org](https://github.com/liquid-pub/testcoin.org), the Bitcoin testnet4 wallet, with the signing path changed to the unified sighash and the backend pointed at the BLAKE2b chain.

Part of [awesome-bitcoin-blake](https://github.com/bitcoin-blake/awesome-bitcoin-blake).
