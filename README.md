# Agent Notary (fully on-chain)

**Live on Base:** [`0x3d6b8e72c81bcbc45cf2522e53189cdd1e21ee71`](https://basescan.org/address/0x3d6b8e72c81bcbc45cf2522e53189cdd1e21ee71#code) (verified source)

Proof that a piece of work existed at a certain time. An agent sends the **SHA-256 hash** of its
work to the contract along with a small ETH fee, and the hash, block time and the agent's address
are recorded forever. Anyone can check it later for free.

**There is no server.** The fee, the stamp, the record, the instructions (`about()`) and even the
ERC-8004 listing all live on the blockchain. Once deployed, it runs with nothing to host.

Only the hash goes on-chain, so the work itself stays private. To prove it later, show the
original file: anyone can hash it and see that it matches the stamp.

```
$ npm run notary -- stamp report.pdf --chain base-sepolia

  ✔ Stamped (paid 0.000005 ETH fee + gas)
  hash       0x4e1e686f…bbe0
  time       2026-10-15T16:31:13.000Z
  block      19283746 on base-sepolia
  requester  0x7099…79C8
  explorer   https://sepolia.basescan.org/tx/0x…
```

## The contract (`contracts/Notary.sol`)

| Function | Who | What |
| --- | --- | --- |
| `stamp(hash, memo)` payable | anyone | Stamp one hash. Send at least `fee()` wei; extra is refunded. Reverts if already stamped, so you keep your money. |
| `stampBatch(hashes, memo)` payable | anyone | Stamp many at once. Pays only for new hashes; skips existing ones. |
| `verify(hash)` | anyone, free | Time, block and requester of the first stamp (time 0 = never stamped). |
| `fee()`, `price(n)` | anyone, free | Current fee per hash. |
| `about()` | anyone, free | Plain-language instructions, readable by any agent from the chain. |
| `setFee(wei)` | owner | Change the fee. |
| `withdraw(to)` | owner | Send collected fees to a wallet. |
| `transferOwnership(addr)` | owner | Hand the contract to someone else. |

The first stamp of a hash wins and can never be changed or deleted. The requester is always the
wallet that paid (`msg.sender`), so it's trustless: no one can stamp on someone else's behalf.

## Try it locally (free, no real money)

```bash
npm install
npm run demo:chain                                   # terminal 1: local test blockchain
npm run deploy -- local                              # terminal 2 (you're the owner)
npm run notary -- stamp README.md --chain local --memo "first stamp"
npm run notary -- verify README.md --chain local
npm run notary -- info --chain local                 # fee, stamps, fees collected
npm run notary -- withdraw --chain local             # collect your fees
npm test
```

## Go live on Base Sepolia (testnet)

1. Make a **throwaway** wallet and get free test ETH from a Base Sepolia faucet.
2. Deploy (you become the owner):
   `DEPLOYER_PRIVATE_KEY=0x… npm run deploy -- base-sepolia --fee 0.000005`
3. List it in ERC-8004 so agents can find it. The listing is stored on-chain, nothing is hosted:
   `PRIVATE_KEY=0x… npm run register -- base-sepolia`
4. Collect fees whenever you like: `PRIVATE_KEY=0x… npm run notary -- withdraw --chain base-sepolia`

Mainnet Base works the same way with `base` instead of `base-sepolia`.

## How an agent uses it (any language)

1. `sha256` the exact bytes of its work.
2. Call `verify(hash)` (free). If the time is 0, it's not stamped yet.
3. Read `fee()`, then call `stamp(hash, memo)` sending that much ETH.

Or with this repo: `PRIVATE_KEY=0x… npm run notary -- stamp work.txt --chain base-sepolia`.

## Commands

```
npm run notary -- hash <file>
npm run notary -- verify <file|hash>
npm run notary -- stamp <file|hash> [--memo text]
npm run notary -- batch <file|hash> <file|hash> ...
npm run notary -- info | about
npm run notary -- set-fee <eth>          (owner)
npm run notary -- withdraw [to]          (owner)
```

All take `--chain base-sepolia` (default), `base`, `sepolia` or `local`. Set your own RPC with
e.g. `RPC_BASE_SEPOLIA=https://…`.

## Costs

- **Fee:** you set it. The default of 0.000005 ETH is about a cent or two.
- **Gas:** one stamp uses about 97k gas; in a batch, about 66k per hash. On Base that's
  typically a fraction of a cent, paid by the agent.

## Trade-offs vs. the x402 version

- Agents pay in **ETH**, not USDC, and pay their own gas.
- x402 directories won't list it. Agents find it through ERC-8004 or the contract address.
- In return, there's nothing to host and nothing that can go down.

Use throwaway keys for everything here, never your main wallet.
