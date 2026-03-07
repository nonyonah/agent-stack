/**
 * server.ts - WebSocket bridge between autonomous agents and the React dashboard
 */

import { WebSocketServer, WebSocket } from "ws";
import { AutonomousAgent } from "./autonomousAgent";

const PORT = Number(process.env.PORT || 4000);
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN;
const MAX_COMMANDS_PER_MIN = Number(process.env.WS_MAX_COMMANDS_PER_MIN || 120);
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 20000);
const ALERT_BALANCE_DROP_SOL = Number(process.env.ALERT_BALANCE_DROP_SOL || 0.5);

type AgentStrategy = "ACCUMULATE" | "DISTRIBUTE" | "PATROL";

interface AgentSnapshot {
  id: string;
  name: string;
  publicKey: string;
  balance: number;
  strategy: AgentStrategy;
  tickCount: number;
  isRunning: boolean;
  lastTick: number;
  consecutiveFailures: number;
  solscanUrl: string;
}

interface TxRecord {
  id: string;
  timestamp: number;
  type: string;
  signature?: string;
  amount?: number;
  to?: string;
  from?: string;
  status: string;
  agentName: string;
  agentId: string;
  solscanUrl?: string;
}

interface DecisionRecord {
  id: string;
  timestamp: number;
  reasoning: string;
  action: string;
  executed: boolean;
  agentName: string;
  agentId: string;
}

type ServerMessage =
  | { type: "INIT"; agents: AgentSnapshot[] }
  | { type: "AGENT_UPDATE"; agent: AgentSnapshot }
  | { type: "TX"; agentId: string; tx: TxRecord }
  | { type: "DECISION"; agentId: string; decision: DecisionRecord }
  | { type: "ALERT"; message: string; severity: "info" | "warning" | "critical"; agentId?: string }
  | { type: "METRICS"; metrics: RuntimeMetrics }
  | { type: "ERROR"; message: string };

type ClientMessage =
  | { type: "AUTH"; token: string }
  | { type: "START_AGENT"; agentId: string }
  | { type: "STOP_AGENT"; agentId: string }
  | { type: "START_ALL" }
  | { type: "STOP_ALL" }
  | { type: "GET_STATE" };

interface RuntimeMetrics {
  connectedClients: number;
  uptimeSec: number;
  commandsLastMinute: number;
  agentCount: number;
  runningAgents: number;
  txBroadcasts: number;
  decisionBroadcasts: number;
  alertsBroadcasts: number;
}

const agents = new Map<string, AutonomousAgent>();
const clients = new Set<WebSocket>();
const authenticated = new WeakMap<WebSocket, boolean>();
const lastEmittedTxByAgent = new Map<string, string>();
const lastEmittedDecisionByAgent = new Map<string, string>();
const lastBalanceByAgent = new Map<string, number>();
const commandTimestampsByClient = new WeakMap<WebSocket, number[]>();
const aliveByClient = new WeakMap<WebSocket, boolean>();

const startupTs = Date.now();

function validateRuntimeConfig(): void {
  const signerMode = process.env.AGENT_SIGNER_MODE || "local";
  if (signerMode === "kms") {
    if (!process.env.AGENT_KMS_KEY_ID) {
      throw new Error("AGENT_SIGNER_MODE=kms but AGENT_KMS_KEY_ID is missing.");
    }

    const hasFilePath = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const hasInlineJson = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    if (!hasFilePath && !hasInlineJson) {
      throw new Error(
        "KMS mode requires Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_APPLICATION_CREDENTIALS_JSON."
      );
    }
  }

  if (!process.env.AGENT_WALLET_SECRET) {
    throw new Error("AGENT_WALLET_SECRET is required.");
  }
}

async function validateOracleConfig(): Promise<void> {
  if (process.env.AGENT_ENABLE_ORACLE_READS !== "true") return;

  const hermesUrl = (process.env.PYTH_HERMES_URL || "https://hermes.pyth.network").replace(/\/+$/, "");
  const feedId = process.env.PYTH_PRICE_FEED_ID;

  if (!feedId) {
    throw new Error("AGENT_ENABLE_ORACLE_READS=true requires PYTH_PRICE_FEED_ID.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(feedId)) {
    throw new Error(
      `PYTH_PRICE_FEED_ID is malformed: "${feedId}". Expected 0x + 64 hex chars.`
    );
  }

  const endpoint = `${hermesUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}&parsed=true`;
  let res: Response;
  try {
    res = await fetch(endpoint, { method: "GET" });
  } catch (err) {
    throw new Error(
      `Failed to reach Pyth Hermes at ${hermesUrl}. Check PYTH_HERMES_URL/network egress. Root cause: ${String(err)}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Pyth Hermes validation failed (${res.status}). Check PYTH_HERMES_URL/PYTH_PRICE_FEED_ID.`
    );
  }

  const body = (await res.json()) as { parsed?: Array<{ id?: string; price?: { price?: string; expo?: number } }> };
  const parsed = body.parsed?.[0];
  if (!parsed || parsed.id?.toLowerCase() !== feedId.toLowerCase() || parsed.price?.price == null || parsed.price?.expo == null) {
    throw new Error(
      `PYTH_PRICE_FEED_ID "${feedId}" did not return a valid parsed price from Hermes.`
    );
  }

  console.log(`[server] Oracle config validated for feed ${feedId.slice(0, 12)}...`);
}
let txBroadcasts = 0;
let decisionBroadcasts = 0;
let alertsBroadcasts = 0;
let commandsLastMinute = 0;
let agentsReady = false;


function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isObject(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case "AUTH":
      return typeof value.token === "string" ? { type: "AUTH", token: value.token } : null;
    case "START_AGENT":
    case "STOP_AGENT":
      return typeof value.agentId === "string"
        ? ({ type: value.type, agentId: value.agentId } as ClientMessage)
        : null;
    case "START_ALL":
    case "STOP_ALL":
    case "GET_STATE":
      return { type: value.type } as ClientMessage;
    default:
      return null;
  }
}

function isAuthorized(ws: WebSocket): boolean {
  return !WS_AUTH_TOKEN || authenticated.get(ws) === true;
}

function sendToClient(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function emitAlert(message: string, severity: "info" | "warning" | "critical", agentId?: string) {
  alertsBroadcasts += 1;
  broadcast({ type: "ALERT", message, severity, agentId });
}

function recordClientCommand(ws: WebSocket): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (commandTimestampsByClient.get(ws) || []).filter((ts) => ts >= windowStart);
  arr.push(now);
  commandTimestampsByClient.set(ws, arr);
  commandsLastMinute++;
  return arr.length <= MAX_COMMANDS_PER_MIN;
}

function getMetrics(): RuntimeMetrics {
  const agentList = [...agents.values()];
  const runningAgents = agentList.filter((a) => {
    const anyAgent = a as unknown as { isRunning?: boolean };
    return anyAgent.isRunning === true;
  }).length;

  return {
    connectedClients: clients.size,
    uptimeSec: Math.floor((Date.now() - startupTs) / 1000),
    commandsLastMinute,
    agentCount: agents.size,
    runningAgents,
    txBroadcasts,
    decisionBroadcasts,
    alertsBroadcasts,
  };
}

async function getSnapshot(agent: AutonomousAgent): Promise<AgentSnapshot> {
  const status = await agent.getStatus();
  return {
    ...status,
    solscanUrl: `https://explorer.solana.com/address/${status.publicKey}?cluster=devnet`,
  };
}

async function buildAgents(): Promise<void> {
  const configs = [
    { name: "alpha-01", strategy: "ACCUMULATE" as const, tickIntervalMs: 9000, minBalance: 0.1 },
    { name: "beta-02", strategy: "DISTRIBUTE" as const, tickIntervalMs: 11000, transferThreshold: 0.5, transferAmount: 0.1 },
    { name: "gamma-03", strategy: "PATROL" as const, tickIntervalMs: 10000, enableDexSwaps: true, enableOracleReads: true, oraclePollEveryTicks: 2 },
  ];

  for (const cfg of configs) {
    const agent = new AutonomousAgent(cfg);
    await agent.init();
    agents.set(agent.getWallet().id, agent);
    console.log(`[server] Agent ${cfg.name} ready - ${agent.getWallet().publicKey}`);
  }

  const pubkeys = [...agents.values()].map((a) => a.getWallet().publicKey);
  for (const [, agent] of agents) {
    agent.setPeers(pubkeys.filter((p) => p !== agent.getWallet().publicKey));
  }

  for (const [, agent] of agents) {
    await agent.bootstrap();
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function handleCommand(msg: ClientMessage, ws?: WebSocket): Promise<void> {
  switch (msg.type) {
    case "AUTH": {
      if (!ws || !WS_AUTH_TOKEN) return;
      authenticated.set(ws, msg.token === WS_AUTH_TOKEN);
      if (!authenticated.get(ws)) {
        sendToClient(ws, { type: "ERROR", message: "Invalid auth token" });
      }
      return;
    }

    case "GET_STATE": {
      const snapshots: AgentSnapshot[] = [];
      for (const [, agent] of agents) snapshots.push(await getSnapshot(agent));
      if (ws) {
        sendToClient(ws, { type: "INIT", agents: snapshots });
        if (!agentsReady) {
          sendToClient(ws, { type: "ERROR", message: "Agents are initializing. State will refresh when ready." });
        }
      } else {
        broadcast({ type: "INIT", agents: snapshots });
      }
      return;
    }

    case "START_AGENT": {
      if (!agentsReady) {
        if (ws) sendToClient(ws, { type: "ERROR", message: "Agents are still initializing. Please try again in a few seconds." });
        return;
      }
      const agent = agents.get(msg.agentId);
      if (!agent) return;
      agent.start(async (status) => {
        const snapshot: AgentSnapshot = {
          ...status,
          solscanUrl: `https://explorer.solana.com/address/${status.publicKey}?cluster=devnet`,
        };

        const prevBal = lastBalanceByAgent.get(status.id);
        if (prevBal != null && prevBal - snapshot.balance >= ALERT_BALANCE_DROP_SOL) {
          emitAlert(
            `Balance drop detected for ${snapshot.name}: ${prevBal.toFixed(4)} -> ${snapshot.balance.toFixed(4)} SOL`,
            "warning",
            snapshot.id
          );
        }
        lastBalanceByAgent.set(status.id, snapshot.balance);

        if (snapshot.consecutiveFailures >= 3) {
          emitAlert(`${snapshot.name} has ${snapshot.consecutiveFailures} consecutive failures.`, "critical", snapshot.id);
        }

        broadcast({ type: "AGENT_UPDATE", agent: snapshot });

        const wallet = agent.getWallet();
        const txs = wallet.getTransactions();
        if (txs.length) {
          const tx = txs[txs.length - 1];
          if (lastEmittedTxByAgent.get(wallet.id) !== tx.id) {
            lastEmittedTxByAgent.set(wallet.id, tx.id);
            txBroadcasts += 1;
            broadcast({
              type: "TX",
              agentId: wallet.id,
              tx: {
                ...tx,
                agentName: wallet.name,
                agentId: wallet.id,
                solscanUrl: tx.signature ? `https://explorer.solana.com/tx/${tx.signature}?cluster=devnet` : undefined,
              },
            });
          }
        }

        const decisions = wallet.getDecisionLog();
        if (decisions.length) {
          const decision = decisions[decisions.length - 1];
          if (lastEmittedDecisionByAgent.get(wallet.id) !== decision.id) {
            lastEmittedDecisionByAgent.set(wallet.id, decision.id);
            decisionBroadcasts += 1;
            broadcast({
              type: "DECISION",
              agentId: wallet.id,
              decision: { ...decision, agentName: wallet.name, agentId: wallet.id },
            });
          }
        }
      });

      broadcast({ type: "AGENT_UPDATE", agent: await getSnapshot(agent) });
      return;
    }

    case "STOP_AGENT": {
      const agent = agents.get(msg.agentId);
      if (!agent) return;
      agent.stop();
      broadcast({ type: "AGENT_UPDATE", agent: await getSnapshot(agent) });
      return;
    }

    case "START_ALL": {
      if (!agentsReady) {
        if (ws) sendToClient(ws, { type: "ERROR", message: "Agents are still initializing. Please try again in a few seconds." });
        return;
      }
      for (const [id] of agents) await handleCommand({ type: "START_AGENT", agentId: id });
      return;
    }

    case "STOP_ALL": {
      for (const [id] of agents) await handleCommand({ type: "STOP_AGENT", agentId: id });
      return;
    }
  }
}

function wireHeartbeat(wss: WebSocketServer) {
  const interval = setInterval(() => {
    for (const ws of clients) {
      const alive = aliveByClient.get(ws);
      if (alive === false) {
        ws.terminate();
        continue;
      }
      aliveByClient.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(interval));
}

async function main(): Promise<void> {
  validateRuntimeConfig();
  await validateOracleConfig();

  const wss = new WebSocketServer({ port: PORT });
  wireHeartbeat(wss);

  setInterval(() => {
    broadcast({ type: "METRICS", metrics: getMetrics() });
    commandsLastMinute = 0;
  }, 60_000);

  console.log(`[server] WebSocket listening on ws://localhost:${PORT}`);

  // Start initialization in background so healthchecks pass quickly.
  void (async () => {
    console.log("[server] Initializing agents...");
    await buildAgents();
    agentsReady = true;
    await handleCommand({ type: "GET_STATE" });
    console.log("[server] Agents initialized.");
  })().catch((err) => {
    console.error("[server] Agent initialization failed:", err);
  });

  wss.on("connection", async (ws) => {
    clients.add(ws);
    authenticated.set(ws, WS_AUTH_TOKEN ? false : true);
    aliveByClient.set(ws, true);
    commandTimestampsByClient.set(ws, []);
    console.log(`[server] Client connected (${clients.size} total)`);

    if (!WS_AUTH_TOKEN) {
      await handleCommand({ type: "GET_STATE" }, ws);
    }

    ws.on("pong", () => {
      aliveByClient.set(ws, true);
    });

    ws.on("message", async (raw) => {
      if (!recordClientCommand(ws)) {
        sendToClient(ws, { type: "ERROR", message: "Rate limit exceeded. Slow down command volume." });
        return;
      }

      const msg = parseClientMessage(raw.toString());
      if (!msg) {
        sendToClient(ws, { type: "ERROR", message: "Invalid message shape" });
        return;
      }

      if (msg.type === "AUTH") {
        await handleCommand(msg, ws);
        if (isAuthorized(ws)) {
          await handleCommand({ type: "GET_STATE" }, ws);
        }
        return;
      }

      if (!isAuthorized(ws)) {
        sendToClient(ws, { type: "ERROR", message: "Unauthorized. Send AUTH first." });
        return;
      }

      await handleCommand(msg, ws);
    });

    ws.on("close", () => {
      clients.delete(ws);
      authenticated.delete(ws);
      commandTimestampsByClient.delete(ws);
      aliveByClient.delete(ws);
      console.log(`[server] Client disconnected (${clients.size} total)`);
    });
  });
}

main().catch((e) => {
  console.error("[server] Fatal:", e);
  process.exit(1);
});
