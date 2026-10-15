// Helpers for talking to the Notary contract directly. No server involved.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, isHex, decodeEventLog, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const artifact = JSON.parse(readFileSync(new URL("./notary-artifact.json", import.meta.url)));
const abi = artifact.abi;
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);

// ERC-8004 Identity Registry addresses (from github.com/erc-8004/erc-8004-contracts).
const ID_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const ID_TESTNET = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

export const CHAINS = {
  "base-sepolia": { id: 84532, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", identityRegistry: ID_TESTNET },
  base: { id: 8453, rpc: "https://mainnet.base.org", explorer: "https://basescan.org", identityRegistry: ID_MAINNET },
  sepolia: { id: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", identityRegistry: ID_TESTNET },
  local: { id: 31337, rpc: "http://127.0.0.1:8545", explorer: null, identityRegistry: null },
};

export function loadDeployments() {
  return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
}
export function saveDeployment(chainName, address) {
  const d = loadDeployments();
  d[chainName] = address;
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
}

export function getChain(name) {
  const c = CHAINS[name];
  if (!c) throw new Error(`Unknown chain "${name}". Use one of: ${Object.keys(CHAINS).join(", ")}`);
  const env = name.toUpperCase().replace(/-/g, "_");
  const rpc = process.env[`RPC_${env}`] || c.rpc;
  const address = process.env.NOTARY_ADDRESS || loadDeployments()[name] || null;
  const viemChain = { id: c.id, name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  return { name, ...c, rpc, address, viemChain };
}

export const publicClient = (chain) => createPublicClient({ chain: chain.viemChain, transport: http(chain.rpc, { timeout: 20_000 }) });
export const walletClient = (chain, privateKey) =>
  createWalletClient({ account: privateKeyToAccount(privateKey), chain: chain.viemChain, transport: http(chain.rpc, { timeout: 20_000 }) });

const need = (chain) => {
  if (!chain.address) throw new Error(`No Notary contract known on ${chain.name}. Deploy one (npm run deploy) or set NOTARY_ADDRESS.`);
};
const read = (chain, functionName, args = []) => publicClient(chain).readContract({ address: chain.address, abi, functionName, args });

// ---- hashing ----

/** SHA-256 of bytes, as 0x-prefixed 32-byte hex (the format the contract stores). */
export const sha256 = (data) => "0x" + createHash("sha256").update(data).digest("hex");
export const hashFile = (path) => sha256(readFileSync(path));

/** Accepts "0x" + 64 hex chars (or without 0x). Returns lowercase 0x form, or null. */
export function normalizeHash(h) {
  if (typeof h !== "string") return null;
  const x = h.startsWith("0x") ? h : "0x" + h;
  if (!isHex(x) || x.length !== 66 || /^0x0{64}$/.test(x)) return null;
  return x.toLowerCase();
}

// ---- reading (free) ----

export async function info(chain) {
  need(chain);
  const [fee, owner, totalStamps, balance] = await Promise.all([
    read(chain, "fee"),
    read(chain, "owner"),
    read(chain, "totalStamps"),
    publicClient(chain).getBalance({ address: chain.address }),
  ]);
  return { chain: chain.name, contract: chain.address, fee, feeEth: formatEther(fee), owner, totalStamps: Number(totalStamps), collected: balance, collectedEth: formatEther(balance) };
}

export async function verify(chain, hash) {
  need(chain);
  const s = await read(chain, "verify", [hash]);
  if (!s.timestamp) return { hash, stamped: false, chain: chain.name };
  let tx = null, memo = null;
  try {
    const block = BigInt(s.blockNumber);
    const logs = await publicClient(chain).getContractEvents({ address: chain.address, abi, eventName: "Stamped", args: { hash }, fromBlock: block, toBlock: block });
    if (logs[0]) {
      tx = logs[0].transactionHash;
      memo = logs[0].args.memo || null;
    }
  } catch {
    /* the event lookup is a nice-to-have */
  }
  return formatStamp(chain, hash, s, tx, memo);
}

export function formatStamp(chain, hash, s, tx, memo) {
  return {
    hash,
    stamped: true,
    chain: chain.name,
    contract: chain.address,
    timestamp: Number(s.timestamp),
    time: new Date(Number(s.timestamp) * 1000).toISOString(),
    block: Number(s.blockNumber),
    requester: s.requester,
    memo: memo || null,
    tx,
    explorer: chain.explorer && tx ? `${chain.explorer}/tx/${tx}` : null,
  };
}

// ---- writing (paid, straight to the contract) ----

function stampedEvents(receipt) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === receipt.to?.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi, ...l });
      } catch {
        return null;
      }
    })
    .filter((e) => e?.eventName === "Stamped");
}

/**
 * Stamps one hash, paying the contract's fee from `privateKey`.
 * Returns { isNew: false, stamp } without spending anything if it's already stamped.
 */
export async function stamp(chain, privateKey, hash, { memo = "" } = {}) {
  need(chain);
  const existing = await verify(chain, hash);
  if (existing.stamped) return { isNew: false, stamp: existing };

  const fee = await read(chain, "fee");
  const wallet = walletClient(chain, privateKey);
  const pub = publicClient(chain);
  // Simulate first: if someone stamps it a moment before us, this fails here and we spend nothing.
  const { request } = await pub.simulateContract({ account: wallet.account, address: chain.address, abi, functionName: "stamp", args: [hash, memo], value: fee });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("Stamp transaction failed");
  const ev = stampedEvents(receipt)[0];
  const s = { timestamp: ev.args.timestamp, blockNumber: receipt.blockNumber, requester: ev.args.requester };
  return { isNew: true, fee, stamp: formatStamp(chain, hash, s, txHash, memo) };
}

/** Stamps many hashes in one transaction; pays only for the new ones. */
export async function stampBatch(chain, privateKey, hashes, { memo = "" } = {}) {
  need(chain);
  const pub = publicClient(chain);
  const status = await Promise.all(hashes.map((h) => read(chain, "verify", [h])));
  const fresh = hashes.filter((h, i) => !status[i].timestamp && hashes.indexOf(h) === i);
  if (!fresh.length) return { added: 0, fee: 0n, stamps: [] };
  const fee = (await read(chain, "fee")) * BigInt(fresh.length);
  const wallet = walletClient(chain, privateKey);
  const { request } = await pub.simulateContract({ account: wallet.account, address: chain.address, abi, functionName: "stampBatch", args: [hashes, memo], value: fee });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("Batch transaction failed");
  const stamps = stampedEvents(receipt).map((ev) =>
    formatStamp(chain, ev.args.hash, { timestamp: ev.args.timestamp, blockNumber: receipt.blockNumber, requester: ev.args.requester }, txHash, memo)
  );
  return { added: stamps.length, fee, stamps };
}

// ---- owner ----

async function ownerWrite(chain, privateKey, functionName, args) {
  need(chain);
  const wallet = walletClient(chain, privateKey);
  const pub = publicClient(chain);
  const { request } = await pub.simulateContract({ account: wallet.account, address: chain.address, abi, functionName, args });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} failed`);
  return hash;
}
export const setFee = (chain, key, weiAmount) => ownerWrite(chain, key, "setFee", [weiAmount]);
export const withdraw = (chain, key, to) => ownerWrite(chain, key, "withdraw", [to]);
