// Registers the notary in the ERC-8004 Identity Registry so agents can discover it.
// The registration file is stored ON-CHAIN as a data: URI, so nothing is hosted anywhere.
//
//   PRIVATE_KEY=0x... npm run register -- base-sepolia
//
// Set IDENTITY_REGISTRY to override the registry address (e.g. on a local chain).
// Use a throwaway testnet key, never your main wallet.

import { readFileSync } from "node:fs";
import { keccak256, toHex, formatEther } from "viem";
import { getChain, publicClient, walletClient, info } from "../src/notary.js";

const name = process.argv[2] || "base-sepolia";
const chain = getChain(name);
const registry = process.env.IDENTITY_REGISTRY || chain.identityRegistry;
const key = process.env.PRIVATE_KEY;
if (!key || !registry) {
  console.error("Usage: PRIVATE_KEY=0x... [IDENTITY_REGISTRY=0x...] npm run register -- <chain>");
  process.exit(1);
}

const i = await info(chain);
const registration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Agent Notary",
  description:
    `Fully on-chain timestamps. Prove your work existed at a point in time: SHA-256 it, then call ` +
    `stamp(bytes32 hash, string memo) on ${i.contract} (chain ${chain.id}) sending fee() wei (now ${i.feeEth} ETH). ` +
    `Duplicates revert so you keep your money. verify(bytes32) is free. Call about() for full instructions.`,
  services: [{ name: "contract", endpoint: `eip155:${chain.id}:${i.contract}` }],
  x402Support: false,
  active: true,
};
const agentURI = "data:application/json;base64," + Buffer.from(JSON.stringify(registration)).toString("base64");

const abi = JSON.parse(readFileSync(new URL("../src/abis/IdentityRegistry.json", import.meta.url)));
const wallet = walletClient(chain, key);
const pub = publicClient(chain);
console.log(`Registering Agent Notary on ${name} (registry ${registry})...`);
const { request } = await pub.simulateContract({ account: wallet.account, address: registry, abi, functionName: "register", args: [agentURI] });
const hash = await wallet.writeContract(request);
const receipt = await pub.waitForTransactionReceipt({ hash });
const log = receipt.logs.find((l) => l.topics[0] === keccak256(toHex("Registered(uint256,string,address)")));
console.log(`Registered! ERC-8004 agentId ${BigInt(log.topics[1])}  (tx ${hash})`);
console.log(`Fee advertised: ${formatEther(i.fee)} ETH. If you change the fee later, agents still read the live fee() from the contract.`);
