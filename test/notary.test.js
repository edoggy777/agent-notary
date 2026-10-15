// Tests against a local chain. Start one first:  npm run demo:chain
// Each run deploys a fresh Notary contract, so tests don't depend on old state.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { getChain, artifact, publicClient, walletClient, normalizeHash, sha256, stamp, stampBatch, verify, info, setFee, withdraw } from "../src/notary.js";

const OWNER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat #0
const AGENT = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // hardhat #1
const OTHER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // hardhat #2
const FEE = parseEther("0.000005");

const chainUp = await fetch("http://127.0.0.1:8545", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
}).then(() => true, () => false);
const skip = chainUp ? false : "local chain not running (npm run demo:chain)";

let chain, pub;
const unique = (label) => sha256(`${label} ${Date.now()} ${Math.random()}`);
const sim = (keyHex, functionName, args, value) => {
  const w = walletClient(chain, keyHex);
  return pub.simulateContract({ account: w.account, address: chain.address, abi: artifact.abi, functionName, args, value });
};
const send = async (keyHex, functionName, args, value) => {
  const { request } = await sim(keyHex, functionName, args, value);
  const hash = await walletClient(chain, keyHex).writeContract(request);
  return pub.waitForTransactionReceipt({ hash });
};

before(async () => {
  if (skip) return;
  const base = getChain("local");
  pub = publicClient(base);
  const hash = await walletClient(base, OWNER).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [FEE] });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  chain = { ...base, address: contractAddress };
});

test("hash format checks", () => {
  const h = sha256("hi");
  assert.equal(normalizeHash(h), h);
  assert.equal(normalizeHash(h.slice(2)), h);
  assert.equal(normalizeHash("0x1234"), null);
  assert.equal(normalizeHash("0x" + "0".repeat(64)), null);
});

test("paying the fee stamps a hash; the payer is the requester", { skip }, async () => {
  const h = unique("report");
  const before = await info(chain);
  const { isNew, stamp: s } = await stamp(chain, AGENT, h, { memo: "v1" });
  assert.equal(isNew, true);
  assert.equal(s.requester, walletClient(chain, AGENT).account.address);
  const v = await verify(chain, h);
  assert.equal(v.timestamp, s.timestamp);
  assert.equal(v.memo, "v1");
  const after = await info(chain);
  assert.equal(after.collected - before.collected, FEE);
});

test("sending too little is rejected", { skip }, async () => {
  await assert.rejects(sim(AGENT, "stamp", [unique("cheap"), ""], FEE - 1n), /FeeTooLow/);
});

test("overpaying is refunded", { skip }, async () => {
  const before = await info(chain);
  await send(AGENT, "stamp", [unique("over"), ""], FEE * 10n);
  const after = await info(chain);
  assert.equal(after.collected - before.collected, FEE);
});

test("a duplicate reverts, so nobody pays twice; first stamp wins", { skip }, async () => {
  const h = unique("dup");
  const first = await stamp(chain, AGENT, h);
  await assert.rejects(sim(OTHER, "stamp", [h, ""], FEE), /AlreadyStamped/);
  const again = await stamp(chain, OTHER, h); // helper checks first and spends nothing
  assert.equal(again.isNew, false);
  assert.equal(again.stamp.requester, first.stamp.requester);
});

test("batch charges only for new hashes and refunds the rest", { skip }, async () => {
  const old = unique("old");
  await stamp(chain, AGENT, old);
  const fresh = [unique("b1"), unique("b2"), unique("b3")];
  const before = await info(chain);
  const r = await stampBatch(chain, OTHER, [old, ...fresh, fresh[0]]);
  assert.equal(r.added, 3);
  const after = await info(chain);
  assert.equal(after.collected - before.collected, FEE * 3n);
  // Sending for 5 when only 1 is new: 4 refunded.
  const before2 = await info(chain);
  await send(OTHER, "stampBatch", [[old, unique("b4")], ""], FEE * 5n);
  assert.equal((await info(chain)).collected - before2.collected, FEE);
  await assert.rejects(sim(OTHER, "stampBatch", [[old], ""], FEE), /NothingNew/);
});

test("only the owner can change the fee or withdraw", { skip }, async () => {
  await assert.rejects(sim(AGENT, "setFee", [0n]), /NotOwner/);
  await assert.rejects(sim(AGENT, "withdraw", [walletClient(chain, AGENT).account.address]), /NotOwner/);
  await setFee(chain, OWNER, FEE * 2n);
  assert.equal((await info(chain)).fee, FEE * 2n);
  await setFee(chain, OWNER, FEE);
});

test("owner withdraws everything collected", { skip }, async () => {
  const to = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // hardhat #4
  const { collected } = await info(chain);
  assert.ok(collected > 0n);
  const balBefore = await pub.getBalance({ address: to });
  await withdraw(chain, OWNER, to);
  assert.equal((await pub.getBalance({ address: to })) - balBefore, collected);
  assert.equal((await info(chain)).collected, 0n);
});

test("a free fee works too, and bad inputs are rejected", { skip }, async () => {
  await setFee(chain, OWNER, 0n);
  const { isNew } = await stamp(chain, AGENT, unique("free"));
  assert.equal(isNew, true);
  await assert.rejects(sim(AGENT, "stamp", ["0x" + "0".repeat(64), ""], 0n), /EmptyHash/);
  await assert.rejects(sim(AGENT, "stamp", [unique("memo"), "x".repeat(281)], 0n), /MemoTooLong/);
  await setFee(chain, OWNER, FEE);
});

test("about() explains itself on-chain", { skip }, async () => {
  const text = await pub.readContract({ address: chain.address, abi: artifact.abi, functionName: "about" });
  assert.match(text, /SHA-256/);
});
