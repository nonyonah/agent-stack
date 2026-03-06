# Deep Dive: Agentic Wallet Design on Solana

## Overview

This document covers the design decisions, security model, and architecture of `solana-agent-wallet` — a prototype system for AI agents that autonomously manage Solana wallets on devnet.

---

## 1. What is an Agentic Wallet?

A standard wallet is designed for humans: it prompts for approval, shows a UI, waits for a click. An **agentic wallet** inverts this model. The agent is the user. It must:

- Create and own a keypair without human input
- Sign transactions programmatically, on a schedule or in response to state
- Store keys securely without a human managing a password manager
- Be observable — every action must be auditable after the fact

The challenge is that most wallet security assumptions break when the agent *is* the signer. There's no hardware wallet, no biometric, no human in the loop. The security perimeter shifts entirely to the software layer.

---

## 2. Key Management

### Keypair Generation

Each agent calls `Keypair.generate()` from `@solana/web3.js`, which uses a cryptographically secure random number generator. The resulting 64-byte secret key is never written to disk in plaintext.

### Encryption at Rest

Before persisting, the secret key is encrypted using:

- **Algorithm**: AES-256-GCM (authenticated encryption — provides both confidentiality and integrity)
- **KDF**: scrypt with a per-wallet random 16-byte salt, deriving a 32-byte key
- **IV**: 16-byte random IV per encryption operation
- **Auth tag**: 16-byte GCM auth tag, stored alongside ciphertext — prevents tampering

```
[salt 16B][iv 16B][authTag 16B][ciphertext 64B] → stored as JSON hex strings
```

The encryption passphrase comes from `AGENT_WALLET_SECRET` env var. In a production deployment, this would be sourced from a secrets manager (AWS Secrets Manager, Vault, etc.) and rotated on a schedule.

### What's Not Done Here (and why)

For a devnet prototype, the following are out of scope but noted for production:

- **HSM / KMS signing**: In production, the private key should never exist in process memory. Instead, use a cloud KMS (AWS KMS, GCP Cloud KMS) where the key never leaves the HSM. The agent sends the transaction bytes to be signed, gets back the signature.
- **Key rotation**: Agents should rotate keypairs periodically, migrating funds before retiring old keys.
- **Multi-sig / threshold signing**: High-value agents should require M-of-N signers.

---

## 3. Architecture: Separation of Concerns

A core design principle is that **wallet mechanics and agent logic are fully decoupled**:

```
AutonomousAgent          AgentWallet SDK          Solana Network
──────────────           ─────────────────        ───────────────
tick()              →    transfer(to, amt)    →   sendAndConfirmTx()
logDecision(...)         sign(transaction)        RPC: devnet
evaluateBalance()        getBalance()             Explorer: devnet
```

The `AgentWallet` class does not know anything about strategies, peers, or timing. It's a pure wallet API. This means:

- The wallet layer can be audited and tested independently
- Swapping the decision engine (e.g. replacing rule-based logic with an LLM) requires zero changes to the wallet
- Multiple agent frameworks can use the same SDK

---

## 4. Agent Decision Engine

Each `AutonomousAgent` runs a tick loop at a configurable interval. On each tick:

1. **Observe**: fetch current SOL balance
2. **Reason**: evaluate balance against strategy thresholds
3. **Decide**: select an action (`hold`, `airdrop`, `transfer`)
4. **Log**: record the decision with full reasoning text before execution
5. **Execute**: call the SDK method
6. **Confirm**: transaction is confirmed on-chain before the tick completes

The decision log is the agent's "brain trace" — every choice is recorded with a timestamp, the reasoning, the intended action, and whether it was executed. This is critical for debugging and for demonstrating to judges that the agent is reasoning, not just firing random transactions.

### Strategies

| Strategy | Logic |
|---|---|
| ACCUMULATE | Hold SOL; request airdrop if below `minBalance` |
| DISTRIBUTE | Transfer to peers when `balance > transferThreshold` |
| PATROL | Alternates every 4 ticks between accumulate and distribute |

Strategies are intentionally simple for the prototype. The extension point is clear: replace the `_strategyX()` methods with LLM inference calls.

---

## 5. Multi-Agent Architecture

The `runAgentSwarm()` function demonstrates that multiple agents can operate independently:

- Each agent has its own keypair, state file, and decision loop
- Agents are wired as peers by exchanging public keys after initialization
- No shared mutable state — each agent reads its own balance from the RPC
- Tick intervals are staggered to avoid RPC rate limiting

This is the foundation for more complex emergent behaviors: one agent as a market maker, another as a trader, another monitoring for arbitrage.

---

## 6. Dashboard & Observability

The React dashboard connects to the agent server via WebSocket. Every tick, the server broadcasts:

- `AGENT_UPDATE`: updated balance, tick count, running status
- `TX`: new transaction with Solscan devnet link
- `DECISION`: agent's reasoning and action

This gives real-time visibility without any polling. The dashboard is purely a read-only observer — it cannot sign transactions or access keypairs.

---

## 7. Threat Model

| Threat | Mitigation |
|---|---|
| Plaintext key on disk | AES-256-GCM encryption at rest |
| Key leakage via logs | SecretKey never logged or serialized without encryption |
| Tampered state file | GCM auth tag — decryption fails if ciphertext is modified |
| Runaway agent | Per-agent `stop()` control; balance thresholds limit max spend per tick |
| RPC rate limiting | Staggered tick intervals; retry on airdrop failure |
| `.agent-wallets/` committed to git | `.gitignore` excludes it; README warns explicitly |

---

## 8. Path to Production

The prototype demonstrates the core loop. To harden for mainnet:

1. Replace file-based storage with KMS-backed signing (never hold key in memory)
2. Add SPL token support via `@solana/spl-token`
3. Integrate a real DEX (Jupiter SDK) for swap actions
4. Add rate limiting and circuit breakers to the agent loop
5. Deploy the WebSocket server behind authentication
6. Use a dedicated devnet → mainnet promotion pipeline with separate key sets
7. Add monitoring/alerting on agent balance anomalies

---

## Conclusion

The key insight of this project is that **agentic wallets require rethinking every assumption of traditional wallet UX**. There's no human to click "approve" — so the security, auditability, and decision-making must be baked into the agent itself. The SDK + agent + dashboard pattern demonstrated here is a clean foundation for building production-grade autonomous Solana agents.
