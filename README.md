# agentstack

Autonomous Solana agent wallet prototype with production-oriented controls.

## Highlights

- Encrypted wallet storage (AES-256-GCM + scrypt)
- Required secret management (`AGENT_WALLET_SECRET`)
- Network-aware behavior (`devnet`/`testnet`/`mainnet-beta`)
- Strategy runtime with retries, per-tick budgets, and circuit-breakers
- WebSocket auth, validation, heartbeat, command rate limits
- Runtime alerts + metrics stream for observability
- SPL token transfer support (`transferSPL`)
- Key rotation API (`rotateKeypair`)
- GCP KMS Ed25519 signing integration (`AGENT_SIGNER_MODE=kms`)

## Run

1. Install dependencies:

```bash
npm install
```

2. Configure env (copy and edit):

```bash
cp .env.example .env
```

3. Start backend:

```bash
AGENT_WALLET_SECRET=your-secret npm run dev:server
```

4. Start frontend:

```bash
VITE_SIMULATED=true npm run dev:client
```

- Frontend: `http://localhost:5173`
- Backend WS: `ws://localhost:4000`

## GCP KMS Setup

1. Create an Ed25519 key in Cloud KMS.
2. Set `AGENT_SIGNER_MODE=kms`.
3. Set `AGENT_KMS_KEY_ID` to a **CryptoKeyVersion** resource path:

```text
projects/<PROJECT_ID>/locations/global/keyRings/<RING>/cryptoKeys/<KEY>/cryptoKeyVersions/<VERSION>
```

4. Provide Google credentials to runtime (`GOOGLE_APPLICATION_CREDENTIALS` or Workload Identity).

In KMS mode:
- Wallet public key is derived from the KMS public key.
- Transactions are signed through `asymmetricSign`.
- Local private-key operations are blocked.

## Notes

- On `mainnet-beta`, airdrop is disabled.
- SPL transfer path requires token account readiness and mint/decimals config.
