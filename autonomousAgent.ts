import { AgentWallet, AgentWalletConfig } from "./index";

export type AgentStrategy = "ACCUMULATE" | "DISTRIBUTE" | "PATROL";

export interface AgentConfig extends AgentWalletConfig {
  strategy: AgentStrategy;
  peers?: string[];
  tickIntervalMs?: number;
  airdropCooldownMs?: number;
  enableOracleReads?: boolean;
  oraclePollEveryTicks?: number;
  pythHermesUrl?: string;
  pythPriceFeedId?: string;
  minBalance?: number;
  transferThreshold?: number;
  transferAmount?: number;
  maxConsecutiveFailures?: number;
  maxActionsPerTick?: number;
  maxTransferPerTick?: number;
  enableSplTransfers?: boolean;
  splMint?: string;
  splDecimals?: number;
  enableDexSwaps?: boolean;
}

export interface AgentStatus {
  id: string;
  name: string;
  publicKey: string;
  balance: number;
  strategy: AgentStrategy;
  tickCount: number;
  isRunning: boolean;
  lastTick: number;
  consecutiveFailures: number;
}

function isAirdropRateLimitedError(err: unknown): boolean {
  const text = String(err).toLowerCase();
  return (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("faucet has run dry") ||
    text.includes("airdrop limit")
  );
}

interface PythLatestPriceResponse {
  parsed?: Array<{ price?: { price?: string; expo?: number; publish_time?: number } }>;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 3,
  delayMs = 600,
  shouldRetry: (err: unknown) => boolean = () => true
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1 && shouldRetry(err)) {
        const waitMs = delayMs * Math.pow(2, i);
        console.warn(`[retry] ${label} failed (attempt ${i + 1}/${retries}). waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

export class AutonomousAgent {
  private wallet: AgentWallet;
  private config: AgentConfig;
  private tickCount = 0;
  private tickInFlight = false;
  private isRunning = false;
  private consecutiveFailures = 0;
  private airdropCooldownUntil = 0;
  private intervalHandle: NodeJS.Timeout | null = null;
  private onStatusChange?: (status: AgentStatus) => void;

  constructor(config: AgentConfig) {
    this.config = {
      tickIntervalMs: 8000,
      minBalance: 0.05,
      transferThreshold: 0.5,
      transferAmount: 0.1,
      maxConsecutiveFailures: 5,
      maxActionsPerTick: 1,
      maxTransferPerTick: 0.25,
      enableSplTransfers: false,
      splDecimals: 6,
      enableDexSwaps: false,
      airdropCooldownMs: Number(process.env.AGENT_AIRDROP_COOLDOWN_MS || 30 * 60 * 1000),
      enableOracleReads: process.env.AGENT_ENABLE_ORACLE_READS === "true",
      oraclePollEveryTicks: Number(process.env.AGENT_ORACLE_POLL_EVERY_TICKS || 3),
      pythHermesUrl: process.env.PYTH_HERMES_URL || "https://hermes.pyth.network",
      // BTC/USD feed id from Pyth docs examples; override with env as needed.
      pythPriceFeedId:
        process.env.PYTH_PRICE_FEED_ID ||
        "0xe62df6c8b4a85fe1a67db0f46fecfc02ca1a96db59ff16f33a6ef8e619f76f4a",
      ...config,
    };
    this.wallet = new AgentWallet(this.config);
  }

  async init(): Promise<void> {
    await this.wallet.create();
    console.log(`[${this.config.name}] Initialized - ${this.wallet.publicKey}`);
  }

  async bootstrap(): Promise<void> {
    if (this.config.network === "mainnet-beta") {
      console.log(`[${this.config.name}] Bootstrap skipped on mainnet-beta.`);
      return;
    }
    console.log(`[${this.config.name}] Requesting devnet airdrop...`);
    try {
      await this._tryAirdrop(1, `${this.config.name}:bootstrap-airdrop`);
    } catch (e) {
      console.warn(`[${this.config.name}] Airdrop failed: ${String(e)}`);
    }
  }

  start(onStatusChange?: (status: AgentStatus) => void): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.onStatusChange = onStatusChange;
    console.log(`[${this.config.name}] Agent started with strategy: ${this.config.strategy}`);
    this.intervalHandle = setInterval(() => {
      void this._tick();
    }, this.config.tickIntervalMs!);
    void this._tick();
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    this.isRunning = false;
    console.log(`[${this.config.name}] Agent stopped after ${this.tickCount} ticks`);
  }

  setPeers(peers: string[]): void {
    this.config.peers = peers;
  }

  getWallet(): AgentWallet {
    return this.wallet;
  }

  async getStatus(): Promise<AgentStatus> {
    const balance = await this.wallet.getBalance().catch(() => 0);
    return {
      id: this.wallet.id,
      name: this.wallet.name,
      publicKey: this.wallet.publicKey,
      balance,
      strategy: this.config.strategy,
      tickCount: this.tickCount,
      isRunning: this.isRunning,
      lastTick: Date.now(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async _tick(): Promise<void> {
    if (this.tickInFlight || !this.isRunning) return;
    this.tickInFlight = true;
    this.tickCount++;

    let actionsTaken = 0;

    try {
      const balance = await withRetry(() => this.wallet.getBalance(), `${this.config.name}:getBalance`, 3, 500);

      const guard = () => {
        if (actionsTaken >= this.config.maxActionsPerTick!) {
          throw new Error(`Tick action budget exceeded for ${this.config.name}`);
        }
        actionsTaken += 1;
      };

      switch (this.config.strategy) {
        case "ACCUMULATE":
          await this._strategyAccumulate(balance, guard);
          break;
        case "DISTRIBUTE":
          await this._strategyDistribute(balance, guard);
          break;
        case "PATROL":
          await this._strategyPatrol(balance, guard);
          break;
      }

      await this._observeOracleIfEnabled();

      this.consecutiveFailures = 0;
      this.onStatusChange?.(await this.getStatus());
    } catch (err) {
      this.consecutiveFailures++;
      console.error(`[${this.config.name}] Tick error (${this.consecutiveFailures} consecutive):`, err);
      if (this.consecutiveFailures >= this.config.maxConsecutiveFailures!) {
        console.error(`[${this.config.name}] Circuit breaker triggered. Stopping agent.`);
        this.stop();
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async _strategyAccumulate(balance: number, guard: () => void): Promise<void> {
    if (balance < this.config.minBalance!) {
      this.wallet.logDecision(
        `Balance ${balance.toFixed(4)} SOL is below minimum ${this.config.minBalance} SOL. Requesting airdrop.`,
        "airdrop",
        true
      );
      guard();
      await this._tryAirdrop(0.5, `${this.config.name}:airdrop`);
    } else {
      this.wallet.logDecision(`Balance ${balance.toFixed(4)} SOL is healthy. Holding position.`, "hold", false);
    }
  }

  private async _strategyDistribute(balance: number, guard: () => void): Promise<void> {
    const peers = this.config.peers || [];
    if (balance > this.config.transferThreshold! && peers.length > 0) {
      const amount = Math.min(this.config.transferAmount!, this.config.maxTransferPerTick!);
      const target = peers[this.tickCount % peers.length];

      this.wallet.logDecision(
        `Balance ${balance.toFixed(4)} SOL exceeds threshold ${this.config.transferThreshold}. Distributing ${amount} SOL to peer ${target.slice(0, 8)}...`,
        `transfer:${amount}:${target}`,
        true
      );
      guard();
      await withRetry(() => this.wallet.transfer(target, amount), `${this.config.name}:transfer`, 3, 900);

      if (this.config.enableSplTransfers && this.config.splMint) {
        this.wallet.logDecision(`SPL rebalance enabled. Sending tiny SPL amount to peer.`, "spl_transfer", true);
        guard();
        await withRetry(
          () => this.wallet.transferSPL(this.config.splMint!, target, 0.01, this.config.splDecimals || 6),
          `${this.config.name}:spl_transfer`,
          2,
          900
        );
      }
    } else if (balance < this.config.minBalance!) {
      this.wallet.logDecision(`Balance too low to distribute. Requesting airdrop.`, "airdrop", true);
      guard();
      await this._tryAirdrop(1, `${this.config.name}:airdrop`);
    } else {
      this.wallet.logDecision(`Balance ${balance.toFixed(4)} SOL is below threshold. Waiting to accumulate.`, "wait", false);
    }
  }

  private async _tryAirdrop(solAmount: number, label: string): Promise<string | null> {
    if (Date.now() < this.airdropCooldownUntil) {
      const waitSec = Math.ceil((this.airdropCooldownUntil - Date.now()) / 1000);
      this.wallet.logDecision(`Faucet cooldown active (${waitSec}s remaining). Skipping airdrop request.`, "airdrop_cooldown", false);
      return null;
    }

    try {
      const sig = await withRetry(
        () => this.wallet.airdrop(solAmount),
        label,
        3,
        700,
        (err) => !isAirdropRateLimitedError(err)
      );
      console.log(`[${this.config.name}] Airdrop confirmed: ${sig}`);
      return sig;
    } catch (err) {
      if (!isAirdropRateLimitedError(err)) throw err;
      this.airdropCooldownUntil = Date.now() + this.config.airdropCooldownMs!;
      const untilIso = new Date(this.airdropCooldownUntil).toISOString();
      console.warn(`[${this.config.name}] Devnet faucet rate-limited. Cooling down airdrops until ${untilIso}.`);
      this.wallet.logDecision(`Devnet faucet rate-limited. Entering cooldown until ${untilIso}.`, "airdrop_cooldown", false);
      return null;
    }
  }

  private async _strategyPatrol(balance: number, guard: () => void): Promise<void> {
    const shouldDistribute = this.tickCount % 4 === 0 && this.config.peers?.length;
    if (shouldDistribute) {
      await this._strategyDistribute(balance, guard);
      if (this.config.enableDexSwaps) {
        this.wallet.logDecision("DEX swap requested by PATROL strategy (stub).", "swap", false);
        this.wallet.logSwapAttempt("DEX integration not wired in prototype. Use Jupiter in production.");
      }
    } else {
      await this._strategyAccumulate(balance, guard);
    }
  }

  private async _observeOracleIfEnabled(): Promise<void> {
    if (!this.config.enableOracleReads) return;
    const every = Math.max(1, this.config.oraclePollEveryTicks || 1);
    if (this.tickCount % every !== 0) return;

    try {
      const { price, publishTime } = await this._fetchPythPrice();
      const published = new Date(publishTime * 1000).toISOString();
      const note = `Pyth oracle read: price=${price.toFixed(2)} USD at ${published}`;
      this.wallet.logDecision(note, "oracle_read", true);
      this.wallet.logCustomEvent(note, "confirmed");
    } catch (err) {
      const note = `Pyth oracle read failed: ${String(err)}`;
      console.warn(`[${this.config.name}] ${note}`);
      this.wallet.logDecision(note, "oracle_read_failed", false);
      this.wallet.logCustomEvent(note, "failed");
    }
  }

  private async _fetchPythPrice(): Promise<{ price: number; publishTime: number }> {
    const baseUrl = (this.config.pythHermesUrl || "https://hermes.pyth.network").replace(/\/+$/, "");
    const feedId = this.config.pythPriceFeedId!;
    const encodedFeed = encodeURIComponent(feedId);
    const hasV2Suffix = /\/v2$/i.test(baseUrl);
    const endpointCandidates = hasV2Suffix
      ? [
          `${baseUrl}/updates/price/latest?ids[]=${encodedFeed}&parsed=true`,
          `${baseUrl.replace(/\/v2$/i, "")}/v2/updates/price/latest?ids[]=${encodedFeed}&parsed=true`,
        ]
      : [
          `${baseUrl}/v2/updates/price/latest?ids[]=${encodedFeed}&parsed=true`,
          `${baseUrl}/updates/price/latest?ids[]=${encodedFeed}&parsed=true`,
        ];

    const result = await withRetry(async () => {
      let lastStatus: number | null = null;
      for (const url of endpointCandidates) {
        const res = await fetch(url, { method: "GET" });
        if (res.status === 404) {
          lastStatus = res.status;
          continue;
        }
        if (!res.ok) {
          throw new Error(`Hermes HTTP ${res.status}`);
        }
        return (await res.json()) as PythLatestPriceResponse;
      }
      throw new Error(`Hermes HTTP ${lastStatus ?? 404}`);
    }, `${this.config.name}:pyth-read`, 3, 500);

    const entry = result.parsed?.[0]?.price;
    if (!entry || entry.price == null || entry.expo == null || entry.publish_time == null) {
      throw new Error("Hermes response missing parsed price fields");
    }

    const numeric = Number(entry.price) * Math.pow(10, entry.expo);
    if (!Number.isFinite(numeric)) {
      throw new Error("Hermes returned invalid price number");
    }

    return { price: numeric, publishTime: entry.publish_time };
  }
}

export default AutonomousAgent;
