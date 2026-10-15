// Deploys the Notary contract and saves its address to deployments.json.
//
//   npm run deploy -- local                                        (built-in test key)
//   DEPLOYER_PRIVATE_KEY=0x... npm run deploy -- base-sepolia --fee 0.000005
//
// --fee is in ETH per stamped hash (default 0.000005 ETH, about a cent or two).
// The deploying wallet becomes the owner: it can change the fee and withdraw fees.
// Use a throwaway testnet key, never your main wallet.

import { parseEther } from "viem";
import { getChain, artifact, publicClient, walletClient, saveDeployment } from "../src/notary.js";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--fee") || "local";
const feeEth = args.includes("--fee") ? args[args.indexOf("--fee") + 1] : "0.000005";
const chain = getChain(name);
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat #0, local only
const key = process.env.DEPLOYER_PRIVATE_KEY || (name === "local" ? LOCAL_KEY : null);
if (!key) {
  console.error(`Set DEPLOYER_PRIVATE_KEY to deploy on ${name}.`);
  process.exit(1);
}

const wallet = walletClient(chain, key);
console.log(`Deploying Notary to ${name} from ${wallet.account.address} with fee ${feeEth} ETH...`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [parseEther(feeEth)] });
const receipt = await publicClient(chain).waitForTransactionReceipt({ hash });
saveDeployment(name, receipt.contractAddress);
console.log(`Notary deployed at ${receipt.contractAddress} (owner ${wallet.account.address})`);
if (chain.explorer) console.log(`${chain.explorer}/address/${receipt.contractAddress}`);
