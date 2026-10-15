// Compiles contracts/Notary.sol with solc-js and writes src/notary-artifact.json.
//   npm run compile
const fs = require("fs"), path = require("path"), solc = require("solc");
const root = path.join(__dirname, "..");
const input = {
  language: "Solidity",
  sources: { "Notary.sol": { content: fs.readFileSync(path.join(root, "contracts/Notary.sol"), "utf8") } },
  settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
const c = out.contracts["Notary.sol"].Notary;
fs.writeFileSync(path.join(root, "src/notary-artifact.json"), JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
console.log("Compiled Notary ->", "src/notary-artifact.json");
