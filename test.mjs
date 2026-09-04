// Runs the 166 Knots unified sighash vectors, then a build/sign/verify round
// trip through the wallet's own transaction builder.
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import {
  unifiedSighash, parseTransaction, SIGHASH_UNIFIED, SIGHASH_ALL, SCRIPT_TYPE_TAPROOT,
} from './unified.js';
import { createTransaction, getTaprootAddress, getXOnlyPubKey, hexToBytes, bytesToHex } from './bitcoin.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('FAIL', msg); } };

// ---- 1. spec vectors -------------------------------------------------------
const vectors = JSON.parse(readFileSync(new URL('./unified_sighash.json', import.meta.url)));
const [header, ...rows] = vectors;
ok(header.join() === 'scriptCode,rawTx,inIdx,hashType,scriptType,spentOutputs,sighash', 'vector header');
const perType = {};
for (const [scriptCodeHex, rawTx, inIdx, hashType, scriptType, spent, expected] of rows) {
  const tx = parseTransaction(hexToBytes(rawTx));
  const spentOutputs = spent.map(([value, script]) => ({ value: BigInt(value), script: hexToBytes(script) }));
  const scriptCode = hexToBytes(scriptCodeHex);
  const opts = scriptType === 3 ? { leafScript: scriptCode } : { scriptCode };
  let got;
  try { got = bytesToHex(unifiedSighash(tx, inIdx, hashType, scriptType, spentOutputs, opts)); }
  catch (e) { got = 'error: ' + e.message; }
  perType[scriptType] = (perType[scriptType] || 0) + 1;
  ok(got === expected, `vector type=${scriptType} hashType=0x${hashType.toString(16)} in=${inIdx}: got ${got} want ${expected}`);
}
console.log(`vectors: ${rows.length} rows, per script type`, perType);

// ---- 2. round trip through createTransaction -------------------------------
const priv = sha256(new TextEncoder().encode('blaketest fixed key'));
const xonly = getXOnlyPubKey(priv);
const from = getTaprootAddress(priv);
const utxos = [
  { txid: 'aa'.repeat(32), vout: 1, value: 50_000 },
  { txid: 'bb'.repeat(32), vout: 0, value: 30_000 },
];
const dest = getTaprootAddress(sha256(new TextEncoder().encode('blaketest destination key')));
const tx = await createTransaction(priv, utxos, dest, 60_000, 2);
const parsed = parseTransaction(hexToBytes(tx.hex));
ok(parsed.segwit && parsed.inputs.length === 2 && parsed.outputs.length === 2, 'round trip shape');
const p2tr = new Uint8Array([0x51, 0x20, ...xonly]);
const spentOutputs = parsed.inputs.map((inp) => {
  const u = utxos.find(u => bytesToHex(Uint8Array.from(inp.txid).reverse()) === u.txid && u.vout === inp.vout);
  return { value: BigInt(u.value), script: p2tr };
});
for (let i = 0; i < parsed.inputs.length; i++) {
  const sig = parsed.inputs[i].witness[0];
  ok(sig.length === 65 && sig[64] === (SIGHASH_ALL | SIGHASH_UNIFIED), `input ${i} carries 0x21`);
  const msg = unifiedSighash(parsed, i, sig[64], SCRIPT_TYPE_TAPROOT, spentOutputs);
  ok(schnorr.verify(sig.subarray(0, 64), msg, xonly), `input ${i} schnorr verifies under unified message`);
}
ok(parsed.outputs[1].script.length === 34 && bytesToHex(parsed.outputs[1].script.subarray(2)) === bytesToHex(xonly), 'change returns to own key');
ok(tx.fee > 0 && tx.totalInput === 80_000 && tx.amount === 60_000, 'amounts');

// legacy (non-unified) path still produces 64-byte BIP341 signatures
const legacy = await createTransaction(priv, utxos, dest, 60_000, 2, { unified: false });
const lp = parseTransaction(hexToBytes(legacy.hex));
ok(lp.inputs.every(i => i.witness[0].length === 64), 'legacy path signs 64-byte SIGHASH_DEFAULT');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
