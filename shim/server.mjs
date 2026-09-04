// esplora-lite: the five Esplora endpoints blaketest uses, served from a
// romanz-style electrs (Electrum protocol) plus Knots RPC for block times.
//
//   node shim/server.mjs [--port 3006] [--electrum 127.0.0.1:50001]
//                        [--rpc 127.0.0.1:48342] [--cookie <path>]
//
// Endpoints: GET /api/address/:a  /api/address/:a/utxo  /api/address/:a/txs
//            GET /api/v1/fees/recommended  /api/blocks/tip/height
//            POST /api/tx (raw hex body)
// CORS is wide open. No auth. Meant for testnet behind localhost or a proxy.

import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { parseTransaction } from '../unified.js';
import { bech32Encode, convertBits, BECH32_CONST, BECH32M_CONST, hexToBytes, bytesToHex, decodeAddress } from '../bitcoin.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const PORT = Number(args.port || 3006);
const [EL_HOST, EL_PORT] = (args.electrum || '127.0.0.1:50001').split(':');
const RPC_URL = `http://${args.rpc || '127.0.0.1:48342'}/`;
const COOKIE = args.cookie || '/home/melvin/knots-testnet4/data/testnet4/.cookie';
const HRP = args.hrp || 'tb';

// ---- Electrum client (one persistent socket, JSON lines) ----------------------
class Electrum {
  constructor() { this.id = 0; this.pending = new Map(); this.buf = ''; this.connect(); }
  connect() {
    this.sock = net.connect(Number(EL_PORT), EL_HOST);
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id); if (!p) continue;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
    this.sock.on('error', (e) => console.error('electrum socket', e.message));
    this.sock.on('close', () => { for (const p of this.pending.values()) p.reject(new Error('electrum disconnected')); this.pending.clear(); setTimeout(() => this.connect(), 2000); });
  }
  call(method, params = []) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`electrum timeout: ${method}`)); }, 30000);
    });
  }
}
const el = new Electrum();

// ---- Knots RPC ---------------------------------------------------------------
async function rpc(method, params = []) {
  const auth = Buffer.from(readFileSync(COOKIE, 'utf8').trim()).toString('base64');
  const r = await fetch(RPC_URL, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'shim', method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// ---- helpers -----------------------------------------------------------------
const scripthash = (script) => bytesToHex(sha256(script).reverse());
function addressToScript(address) {
  const d = decodeAddress(address);
  if (d.type === 'p2tr') return new Uint8Array([0x51, 0x20, ...d.hash]);
  if (d.type === 'p2wpkh') return new Uint8Array([0x00, 0x14, ...d.hash]);
  return new Uint8Array([0x00, 0x20, ...d.hash]);
}
function scriptToAddress(script) {
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return bech32Encode(HRP, [0, ...convertBits([...script.subarray(2)], 8, 5)], BECH32_CONST);
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return bech32Encode(HRP, [0, ...convertBits([...script.subarray(2)], 8, 5)], BECH32_CONST);
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return bech32Encode(HRP, [1, ...convertBits([...script.subarray(2)], 8, 5)], BECH32M_CONST);
  return null;
}
function scriptType(script) {
  if (script.length === 22 && script[0] === 0) return 'v0_p2wpkh';
  if (script.length === 34 && script[0] === 0) return 'v0_p2wsh';
  if (script.length === 34 && script[0] === 0x51) return 'v1_p2tr';
  if (script.length && script[0] === 0x6a) return 'op_return';
  return 'unknown';
}
const txCache = new Map();
async function getTx(txid) {
  if (txCache.has(txid)) return txCache.get(txid);
  const hex = await el.call('blockchain.transaction.get', [txid]);
  const parsed = parseTransaction(hexToBytes(hex));
  const entry = { hex, parsed };
  if (txCache.size > 5000) txCache.clear();
  txCache.set(txid, entry);
  return entry;
}
const blockTimeCache = new Map();
async function blockInfo(height) {
  if (blockTimeCache.has(height)) return blockTimeCache.get(height);
  const hash = await rpc('getblockhash', [height]);
  const hdr = await rpc('getblockheader', [hash]);
  const info = { block_hash: hash, block_time: hdr.time };
  blockTimeCache.set(height, info);
  return info;
}
async function esploraTx(txid, height) {
  const { parsed } = await getTx(txid);
  const vin = [];
  for (const inp of parsed.inputs) {
    const prevTxid = bytesToHex(Uint8Array.from(inp.txid).reverse());
    let prevout = null;
    try {
      const { parsed: prev } = await getTx(prevTxid);
      const o = prev.outputs[inp.vout];
      prevout = { scriptpubkey: bytesToHex(o.script), scriptpubkey_type: scriptType(o.script), scriptpubkey_address: scriptToAddress(o.script), value: Number(o.value) };
    } catch (e) { /* coinbase or unavailable */ }
    vin.push({ txid: prevTxid, vout: inp.vout, prevout, scriptsig: bytesToHex(inp.scriptSig), witness: inp.witness.map(bytesToHex), is_coinbase: prevTxid === '0'.repeat(64), sequence: inp.sequence });
  }
  const vout = parsed.outputs.map(o => ({ scriptpubkey: bytesToHex(o.script), scriptpubkey_type: scriptType(o.script), scriptpubkey_address: scriptToAddress(o.script), value: Number(o.value) }));
  const status = height > 0 ? { confirmed: true, block_height: height, ...(await blockInfo(height)) } : { confirmed: false };
  return { txid, version: parsed.version, locktime: parsed.locktime, vin, vout, size: getTxSize(txid), weight: null, fee: null, status };
}
function getTxSize(txid) { const e = txCache.get(txid); return e ? e.hex.length / 2 : null; }

// ---- handlers -----------------------------------------------------------------
async function handle(method, path, body) {
  let m;
  if (method === 'GET' && (m = path.match(/^\/api\/address\/([a-zA-Z0-9]+)$/))) {
    const sh = scripthash(addressToScript(m[1]));
    const [bal, hist] = await Promise.all([el.call('blockchain.scripthash.get_balance', [sh]), el.call('blockchain.scripthash.get_history', [sh])]);
    const confirmedTxs = hist.filter(h => h.height > 0).length;
    const unconf = bal.unconfirmed;
    return { address: m[1],
      chain_stats: { funded_txo_count: null, funded_txo_sum: bal.confirmed, spent_txo_count: null, spent_txo_sum: 0, tx_count: confirmedTxs },
      mempool_stats: { funded_txo_count: null, funded_txo_sum: unconf > 0 ? unconf : 0, spent_txo_count: null, spent_txo_sum: unconf < 0 ? -unconf : 0, tx_count: hist.length - confirmedTxs } };
  }
  if (method === 'GET' && (m = path.match(/^\/api\/address\/([a-zA-Z0-9]+)\/utxo$/))) {
    const sh = scripthash(addressToScript(m[1]));
    const us = await el.call('blockchain.scripthash.listunspent', [sh]);
    return Promise.all(us.map(async u => ({ txid: u.tx_hash, vout: u.tx_pos, value: u.value,
      status: u.height > 0 ? { confirmed: true, block_height: u.height, ...(await blockInfo(u.height)) } : { confirmed: false } })));
  }
  if (method === 'GET' && (m = path.match(/^\/api\/address\/([a-zA-Z0-9]+)\/txs$/))) {
    const sh = scripthash(addressToScript(m[1]));
    const hist = await el.call('blockchain.scripthash.get_history', [sh]);
    // newest first: mempool (height 0 or -1) then descending height
    hist.sort((a, b) => (a.height <= 0 ? 1e12 : a.height) < (b.height <= 0 ? 1e12 : b.height) ? 1 : -1);
    return Promise.all(hist.slice(0, 25).map(h => esploraTx(h.tx_hash, h.height)));
  }
  if (method === 'GET' && (m = path.match(/^\/api\/tx\/([0-9a-f]{64})$/))) {
    return esploraTx(m[1], 0);
  }
  if (method === 'GET' && path === '/api/v1/fees/recommended') {
    const est = async (n) => { const f = await el.call('blockchain.estimatefee', [n]); return f > 0 ? Math.max(1, Math.round(f * 1e8 / 1000)) : 1; };
    const [fast, half, hour] = await Promise.all([est(1), est(3), est(6)]);
    return { fastestFee: fast, halfHourFee: half, hourFee: hour, economyFee: 1, minimumFee: 1 };
  }
  if (method === 'GET' && path === '/api/blocks/tip/height') {
    const h = await el.call('blockchain.headers.subscribe', []);
    return { raw: String(h.height) };
  }
  if (method === 'POST' && path === '/api/tx') {
    const hex = body.trim();
    if (!/^[0-9a-f]+$/i.test(hex)) throw Object.assign(new Error('body must be raw transaction hex'), { status: 400 });
    const txid = await el.call('blockchain.transaction.broadcast', [hex]);
    return { raw: txid };
  }
  throw Object.assign(new Error('not found'), { status: 404 });
}

http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = ''; for await (const c of req) body += c;
  const url = new URL(req.url, 'http://x');
  console.log(new Date().toISOString().slice(11,19), req.method, url.pathname, req.headers.origin || '');
  try {
    const out = await handle(req.method, url.pathname, body);
    if (out && typeof out === 'object' && 'raw' in out && Object.keys(out).length === 1) { res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' }); return res.end(out.raw); }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(e.status || 500, { ...cors, 'Content-Type': 'text/plain' }); res.end(e.message);
    if (!e.status) console.error(req.method, url.pathname, e.message);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`esplora-lite on http://127.0.0.1:${PORT}/api -> electrum ${EL_HOST}:${EL_PORT}, rpc ${RPC_URL}`));
