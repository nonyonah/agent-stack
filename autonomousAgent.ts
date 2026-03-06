import { AgentWallet, AgentWalletConfig } from "./index";

export type AgentStrategy = "ACCUMULATE" | "DISTRIBUTE" | "PATROL";

export interface AgentConfig extends AgentWalletConfig {
  strategy: AgentStrategy;
  peers?: string[];
  tickIntervalMs?: number;
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

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3, delayMs = 600): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        const waitMs = delayMs * Math.pow(2, i);
        console.warn(`[retry] ${label} failed (attempt ${i + 1}/${retries}). waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
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
      const sig = await withRetry(() => this.wallet.airdrop(1), `${this.config.name}:bootstrap-airdrop`, 3, 700);
      console.log(`[${this.config.name}] Airdrop confirmed: ${sig}`);
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
      await withRetry(() => this.wallet.airdrop(0.5), `${this.config.name}:airdrop`, 3, 800);
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
      await withRetry(() => this.wallet.airdrop(1), `${this.config.name}:airdrop`, 3, 800);
    } else {
      this.wallet.logDecision(`Balance ${balance.toFixed(4)} SOL is below threshold. Waiting to accumulate.`, "wait", false);
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
}

export default AutonomousAgent;
