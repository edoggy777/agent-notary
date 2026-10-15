#!/usr/bin/env node
// Terminal tool for the fully on-chain notary. Every command talks straight to the contract.
//
//   hash    <file>                         print a file's SHA-256
//   verify  <file|hash>                    when was it stamped? (free)
//   stamp   <file|hash> [--memo text]      stamp it, paying the contract's fee (needs PRIVATE_KEY)
//   batch   <file|hash> <file|hash> ...    stamp several in one transaction
//   info                                   fee, owner, total stamps, fees collected
//   about                                  the contract's own instructions, read from the chain
//   set-fee <eth>                          owner only
//   withdraw [to]                          owner only: send collected fees to you (or `to`)
//
// Options: --chain base-sepolia (default) | base | sepolia | local

import { existsSync } from "node:fs";
import { parseEther, formatEther, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, hashFile, normalizeHash, verify, stamp, stampBatch, info, setFee, withdraw, publicClient, artifact } from "./notary.js";

const LOCAL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // hardhat test account #1
const LOCAL_OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat #0 (deployer)

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--chain", "--memo"]);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
const [cmd, ...targets] = positional;
const chainName = flag("chain") || process.env.CHAIN || "base-sepolia";
const chain = getChain(chainName);

function usage() {
  console.error(`Usage: node src/cli.js <command> [args] [--chain base-sepolia|base|sepolia|local]
  hash <file>                 verify <file|hash>           info
  stamp <file|hash> [--memo]  batch <file|hash> ...        about
  set-fee <eth>               withdraw [to]`);
  process.exit(1);
}

function toHash(t) {
  if (!t) usage();
  if (existsSync(t)) return hashFile(t);
  const h = normalizeHash(t);
  if (!h) {
    console.error(`"${t}" is neither a file nor a 0x + 64-hex hash.`);
    process.exit(1);
  }
  return h;
}

function key(owner = false) {
  const k = process.env.PRIVATE_KEY || (chainName === "local" ? (owner ? LOCAL_OWNER_KEY : LOCAL_KEY) : null);
  if (!k) {
    console.error("Set PRIVATE_KEY to a wallet with a little ETH (fee + gas). Use a throwaway testnet key.");
    process.exit(1);
  }
  return k;
}

function show(s, extra = "") {
  if (!s.stamped) return console.log(`\n  Not stamped on ${s.chain}.\n  ${s.hash}\n`);
  console.log(`\n  ✔ Stamped ${extra}`);
  console.log(`  hash       ${s.hash}`);
  console.log(`  time       ${s.time}`);
  console.log(`  block      ${s.block} on ${s.chain}`);
  console.log(`  requester  ${s.requester}`);
  if (s.memo) console.log(`  memo       ${s.memo}`);
  if (s.tx) console.log(`  tx         ${s.tx}`);
  if (s.explorer) console.log(`  explorer   ${s.explorer}`);
  console.log();
}

function explain(err) {
  const name = err?.cause?.data?.errorName || err?.data?.errorName || err?.cause?.reason;
  const msg = err.shortMessage || err.message;
  if (name === "NotOwner") return "Only the contract owner can do that.";
  if (/insufficient funds/i.test(msg)) return "Not enough ETH in this wallet for the fee plus gas.";
  return name ? `Contract said: ${name}` : msg;
}

try {
  switch (cmd) {
    case "hash":
      console.log(toHash(targets[0]));
      break;

    case "verify":
      show(await verify(chain, toHash(targets[0])));
      break;

    case "stamp": {
      const r = await stamp(chain, key(), toHash(targets[0]), { memo: flag("memo") || "" });
      show(r.stamp, r.isNew ? `(paid ${formatEther(r.fee)} ETH fee + gas)` : "(already existed, nothing spent)");
      break;
    }

    case "batch": {
      if (!targets.length) usage();
      const r = await stampBatch(chain, key(), targets.map(toHash), { memo: flag("memo") || "" });
      console.log(`\n  ${r.added} new hash(es) stamped, ${targets.length - r.added} skipped. Paid ${formatEther(r.fee)} ETH in fees.`);
      for (const s of r.stamps) console.log(`  ${s.hash}  ${s.time}`);
      if (r.stamps[0]?.explorer) console.log(`  ${r.stamps[0].explorer}`);
      console.log();
      break;
    }

    case "info": {
      const i = await info(chain);
      console.log(`\n  Notary on ${i.chain}\n  contract   ${i.contract}\n  fee        ${i.feeEth} ETH per hash\n  owner      ${i.owner}\n  stamps     ${i.totalStamps}\n  collected  ${i.collectedEth} ETH (owner can withdraw)\n`);
      break;
    }

    case "about": {
      const text = await publicClient(chain).readContract({ address: chain.address, abi: artifact.abi, functionName: "about" });
      console.log(`\n${text}\n`);
      break;
    }

    case "set-fee": {
      if (!targets[0]) usage();
      await setFee(chain, key(true), parseEther(targets[0]));
      console.log(`Fee is now ${targets[0]} ETH per hash.`);
      break;
    }

    case "withdraw": {
      const k = key(true);
      const to = targets[0] || privateKeyToAccount(k).address;
      if (!isAddress(to)) throw new Error(`"${to}" is not an address`);
      const before = (await info(chain)).collectedEth;
      await withdraw(chain, k, to);
      console.log(`Sent ${before} ETH to ${to}.`);
      break;
    }

    default:
      usage();
  }
} catch (err) {
  console.error(`Error: ${explain(err)}`);
  process.exit(1);
}
