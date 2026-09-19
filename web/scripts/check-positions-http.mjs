import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { parseAbi, decodeFunctionData, encodeFunctionResult } from 'viem';
// Run after scripts/verify.sh, which builds the app with this synthetic deployment.
const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const deployment = JSON.parse(readFileSync(`${root}/tools/fixtures/deployment.json`, 'utf8'));
const wallet = `0x${'2'.repeat(40)}`, leg = `0x${'3'.repeat(40)}`, hash = `0x${'a'.repeat(64)}`;
const abi = parseAbi(['struct Leg { address vault; bool isYes; }', 'struct Parlay { Leg[] legs; address writer; uint96 premium; uint96 maxPayout; uint8 status; }', 'function parlay(uint256 id) view returns (Parlay)', 'function settled() view returns (bool)']);
const counts = {};
let fail = false;
const now = Math.floor(Date.now() / 1000);
const meta = { block: { number: 100, hash, timestamp: now }, hasIndexingErrors: false };
const tickets = Array.from({length: 21}, (_, i) => ({ ticket: { id: `998:${deployment.parlayVault}:${21-i}`, number: String(21-i), taker: wallet, owner: wallet, premium: '1000000', maxPayout: '2000000', status: 0, burned: false, burnHolder: null, mintBlock: '1', mintHash: hash, mintTimestamp: String(now - 100) } }));
const fixture = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/graphql') {
    const input = JSON.parse(raw);
    if (fail) return res.end(JSON.stringify({ errors: [{ message: 'fixture provider unavailable' }] }));
    return res.end(JSON.stringify({ data: input.variables ? { _meta: meta, deployment: { chainId: '998', vault: deployment.parlayVault, startBlock: '1', schemaVersion: 1 }, walletTickets: tickets.filter(t => BigInt(t.ticket.number) < BigInt(input.variables.before)).slice(0, input.variables.first) } : { _meta: meta } }));
  }
  const input = JSON.parse(raw); counts[input.method] = (counts[input.method] ?? 0) + 1;
  let result;
  if (input.method === 'eth_chainId') result = '0x3e6';
  else if (input.method === 'eth_getBlockByNumber') result = { number: '0x64', hash, parentHash: hash, timestamp: `0x${now.toString(16)}`, transactions: [], uncles: [], gasLimit: '0x1', gasUsed: '0x0', size: '0x1', extraData: '0x', nonce: '0x0000000000000000', logsBloom: `0x${'0'.repeat(512)}`, miner: wallet, difficulty: '0x0', totalDifficulty: '0x0' };
  else if (input.method === 'eth_call') {
    const {functionName} = decodeFunctionData({ abi, data: input.params[0].data });
    result = encodeFunctionResult({ abi, functionName, result: functionName === 'settled' ? false : { legs: [{ vault: leg, isYes: true }], writer: wallet, premium: 1000000n, maxPayout: 2000000n, status: 0 } });
  } else throw new Error(`Unexpected RPC ${input.method}`);
  res.end(JSON.stringify({jsonrpc:'2.0', id:input.id, result}));
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: `${root}/web`, env: { ...process.env, NEXT_TELEMETRY_DISABLED:'1', DEPLOYMENT_FILE:`${root}/tools/fixtures/deployment.json`, NEXT_PUBLIC_CHAIN_ID:'998', NEXT_PUBLIC_PARLAY_VAULT:deployment.parlayVault, NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK:'1', NEXT_PUBLIC_POSITIONS_SOURCE:'subgraph', POSITIONS_SUBGRAPH_URL:`${fixtureUrl}/graphql`, POSITIONS_RPC_URL:`${fixtureUrl}/rpc` }, stdio: ['ignore', 'ignore', 'ignore'] });
try {
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) { try { await fetch(`${url}/api/positions?wallet=bad`); break; } catch { if (attempt > 100) throw new Error('Local app did not start'); await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.equal((await fetch(`${url}/api/positions?wallet=bad`)).status, 400);
  const response = await fetch(`${url}/api/positions?wallet=${wallet}`);
  assert.equal(response.status, 200, await response.clone().text());
  const first = await response.json(); assert.equal(first.rows.length, 20); assert.equal(first.next, '2');
  assert.equal(first.rows[0].owner, wallet); assert.deepEqual(first.rows[0].legVerdicts, ['pending']);
  const second = await (await fetch(`${url}/api/positions?wallet=${wallet}&before=2&block=100&snapshot=${hash}`)).json();
  assert.equal(second.rows.length, 1); assert.equal(second.next, null);
  assert.equal(counts.eth_call, 22); // 21 unique tickets + one shared outcome, across two pages.
  fail = true;
  assert.equal((await fetch(`${url}/api/positions?wallet=${leg}`)).status, 503);
  assert.equal((await fetch(`${url}/position-markets.json`)).status, 200);
  const html = await (await fetch(`${url}/positions`)).text(); assert.match(html, /Your slips/);
  console.log('PASS: production HTTP route: 400 validation, 20+1 paginated tickets, deduped outcomes (22 eth_call), provider failure 503, static labels, positions HTML');
} finally { app.kill('SIGTERM'); await once(app, 'exit'); await new Promise(resolve => fixture.close(resolve)); }
