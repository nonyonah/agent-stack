# SKILLS.md — solana-agent-wallet

> This file describes the capabilities, interfaces, and operational context of the `solana-agent-wallet` system for use by AI agents reading this repository.

---

## What This System Does

`solana-agent-wallet` is a TypeScript SDK and runtime that allows AI agents to autonomously create, manage, and transact with Solana wallets — without human intervention.

Each agent instance:
- Owns a unique Solana keypair (stored encrypted at rest)
- Can hold, receive, and send SOL and SPL tokens on devnet
- Executes a decision loop based on a configurable strategy
- Logs all decisions and transactions for auditability

---

## SDK Interface (`packages/sdk`)

```ts
import AgentWallet from "solana-agent-wallet-sdk";

const wallet = new AgentWallet({ name: "my-agent" });

// Lifecycle
await wallet.create()           // Generate + encrypt + persist keypair
await wallet.load(agentId)      // Load existing wallet from disk

// Funds
await wallet.getBalance()       // → number (SOL)
await wallet.airdrop(1)         // Request devnet SOL → TransactionSignature

// Transactions
await wallet.transfer(to, 0.1)  // Sign + send SOL → TransactionSignature
await wallet.signAndSendRaw(tx) // Sign any Transaction object

// Agent layer
wallet.logDecision(reasoning, action, executed)  // Append to decision log
wallet.getState()               // Full AgentState snapshot
wallet.getTransactions()        // All transaction records
wallet.getDecisionLog()         // All decision records

// Static
AgentWallet.listAgents(dir)     // List all persisted agents
```

---

## Agent Strategies (`packages/agent`)

Agents run one of three built-in strategies:

| Strategy | Behavior |
|---|---|
| `ACCUMULATE` | Hold SOL; airdrop if below minimum threshold |
| `DISTRIBUTE` | Send SOL to peers when balance exceeds threshold |
| `PATROL` | Alternates between accumulate and distribute every N ticks |

### Running an agent

```ts
import AutonomousAgent from "solana-agent-wallet-agent";

const agent = new AutonomousAgent({
  name: "alpha-01",
  strategy: "DISTRIBUTE",
  peers: ["<peer-pubkey>"],
  tickIntervalMs: 8000,
  transferThreshold: 0.5,
  transferAmount: 0.1,
});

await agent.init();
await agent.bootstrap();  // devnet airdrop
agent.start();            // begins autonomous loop
```

### Running a multi-agent swarm

```ts
import { runAgentSwarm } from "solana-agent-wallet-agent";

const agents = await runAgentSwarm([
  { name: "alpha-01", strategy: "ACCUMULATE" },
  { name: "beta-02",  strategy: "DISTRIBUTE" },
  { name: "gamma-03", strategy: "PATROL" },
]);
```

---

## Security Design

| Concern | Approach |
|---|---|
| Key storage | AES-256-GCM encryption, scrypt KDF, per-wallet salt |
| Key exposure | Keypair never logged or serialized in plaintext |
| Encryption key | Loaded from `AGENT_WALLET_SECRET` env var |
| Network | All transactions on devnet only in this prototype |
| Isolation | Each agent has its own state file and keypair |

---

## File Layout

```
.agent-wallets/
  <agent-id>.json    ← encrypted keypair + state (never commit this)
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AGENT_WALLET_SECRET` | Recommended | Encryption passphrase for keypair storage. Falls back to an insecure default for devnet demos. |
| `SOLANA_RPC_URL` | Optional | Override devnet RPC endpoint |

---

## Transaction Records

Every wallet action is recorded:

```ts
{
  id: string,
  timestamp: number,
  type: "transfer" | "airdrop" | "swap" | "custom",
  signature?: string,        // Solana tx signature (verify on Solscan devnet)
  amount?: number,           // SOL amount
  to?: string,               // recipient public key
  from?: string,             // sender public key
  status: "pending" | "confirmed" | "failed",
}
```

---

## Extending the SDK

To add a new action (e.g. SPL token transfer):
1. Add method to `AgentWallet` class in `packages/sdk/src/index.ts`
2. Add strategy logic in `packages/agent/src/index.ts`
3. Call `wallet.logDecision(...)` before and after execution

---

## Network

This prototype runs on **Solana Devnet**.
- RPC: `https://api.devnet.solana.com`
- Faucet: `https://faucet.solana.com`
- Explorer: `https://explorer.solana.com?cluster=devnet`
