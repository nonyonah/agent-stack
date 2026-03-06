import { useState, useEffect, useRef, useCallback } from "react";

export interface AgentSnapshot {
  id: string;
  name: string;
  publicKey: string;
  balance: number;
  strategy: "ACCUMULATE" | "DISTRIBUTE" | "PATROL";
  tickCount: number;
  isRunning: boolean;
  lastTick: number;
  consecutiveFailures?: number;
  solscanUrl: string;
}

export interface TxRecord {
  id: string;
  timestamp: number;
  type: "transfer" | "airdrop" | "spl_transfer" | "swap" | "custom";
  signature?: string;
  amount?: number;
  to?: string;
  from?: string;
  status: "pending" | "confirmed" | "failed";
  agentName: string;
  agentId: string;
  solscanUrl?: string;
}

export interface DecisionRecord {
  id: string;
  timestamp: number;
  reasoning: string;
  action: string;
  executed: boolean;
  agentName: string;
  agentId: string;
}

export interface AlertRecord {
  id: string;
  timestamp: number;
  severity: "info" | "warning" | "critical";
  message: string;
  agentId?: string;
}

export interface RuntimeMetrics {
  connectedClients: number;
  uptimeSec: number;
  commandsLastMinute: number;
  agentCount: number;
  runningAgents: number;
  txBroadcasts: number;
  decisionBroadcasts: number;
  alertsBroadcasts: number;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:4000";
const WS_AUTH_TOKEN = import.meta.env.VITE_WS_AUTH_TOKEN || "";

export function useAgentWallet() {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [txLog, setTxLog] = useState<TxRecord[]>([]);
  const [decisionLog, setDecisionLog] = useState<DecisionRecord[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setStatus("connecting");

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      if (WS_AUTH_TOKEN) ws.send(JSON.stringify({ type: "AUTH", token: WS_AUTH_TOKEN }));
      else ws.send(JSON.stringify({ type: "GET_STATE" }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "INIT":
          setAgents(msg.agents);
          break;
        case "AGENT_UPDATE":
          setAgents((prev) => {
            const idx = prev.findIndex((a) => a.id === msg.agent.id);
            if (idx === -1) return [msg.agent, ...prev];
            const next = [...prev];
            next[idx] = msg.agent;
            return next;
          });
          break;
        case "TX":
          setTxLog((prev) => [msg.tx, ...prev].slice(0, 100));
          break;
        case "DECISION":
          setDecisionLog((prev) => [msg.decision, ...prev].slice(0, 100));
          break;
        case "ALERT":
          setAlerts((prev) => [
            { id: Math.random().toString(36).slice(2), timestamp: Date.now(), severity: msg.severity, message: msg.message, agentId: msg.agentId },
            ...prev,
          ].slice(0, 60));
          break;
        case "METRICS":
          setMetrics(msg.metrics);
          break;
        case "ERROR":
          console.error("[ws]", msg.message);
          break;
      }
    };

    ws.onerror = () => setStatus("error");

    ws.onclose = () => {
      setStatus("disconnected");
      reconnectTimer.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      reconnectTimer.current && clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return {
    agents,
    txLog,
    decisionLog,
    alerts,
    metrics,
    status,
    startAgent: (id: string) => send({ type: "START_AGENT", agentId: id }),
    stopAgent: (id: string) => send({ type: "STOP_AGENT", agentId: id }),
    startAll: () => send({ type: "START_ALL" }),
    stopAll: () => send({ type: "STOP_ALL" }),
    anyRunning: agents.some((a) => a.isRunning),
    totalBalance: agents.reduce((s, a) => s + a.balance, 0),
    totalTxs: txLog.length,
  };
}

const STRATEGIES = ["ACCUMULATE", "DISTRIBUTE", "PATROL"] as const;
const AGENT_NAMES = ["alpha-01", "beta-02", "gamma-03"];

const DECISIONS: Record<string, [string, string, boolean][]> = {
  ACCUMULATE: [
    ["Balance below minimum. Requesting emergency devnet airdrop.", "airdrop", true],
    ["Balance healthy. Holding position - accumulation phase active.", "hold", false],
    ["Tick check nominal. SOL reserves adequate, no action needed.", "hold", false],
  ],
  DISTRIBUTE: [
    ["Balance exceeds distribution threshold. Sending 0.1 SOL to peer.", "transfer", true],
    ["Peer detected with lower balance. Initiating rebalance.", "transfer", true],
    ["Balance too low to distribute. Requesting airdrop first.", "airdrop", true],
    ["Threshold not met. Waiting to accumulate before distributing.", "wait", false],
  ],
  PATROL: [
    ["Patrol tick 4: switching to distribution mode.", "transfer", true],
    ["Patrol check: accumulation phase active.", "hold", false],
    ["Peer balance delta detected. Rebalancing.", "transfer", true],
    ["Patrol cycle complete. Monitoring network state.", "hold", false],
  ],
};

function rndId() { return Math.random().toString(36).slice(2, 10); }
function rndPubkey() { const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; return Array.from({ length: 44 }, () => a[Math.floor(Math.random() * 58)]).join(""); }
function rndSig() { const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; return Array.from({ length: 88 }, () => a[Math.floor(Math.random() * 58)]).join(""); }

function makeSimAgents(): AgentSnapshot[] {
  return AGENT_NAMES.map((name, i) => ({
    id: rndId(), name,
    publicKey: rndPubkey(),
    balance: 0.5 + Math.random() * 1.5,
    strategy: STRATEGIES[i],
    tickCount: 0,
    isRunning: false,
    lastTick: Date.now(),
    solscanUrl: `https://explorer.solana.com?cluster=devnet`,
  }));
}

export function useAgentWalletSimulated() {
  const [agents, setAgents] = useState<AgentSnapshot[]>(makeSimAgents);
  const [txLog, setTxLog] = useState<TxRecord[]>([]);
  const [decisionLog, setDecisionLog] = useState<DecisionRecord[]>([]);
  const tickRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(() => {
    tickRef.current++;
    setAgents((prev) => {
      return prev.map((agent) => {
        if (!agent.isRunning) return agent;
        const pool = DECISIONS[agent.strategy];
        const [reasoning, action, executed] = pool[tickRef.current % pool.length];

        const decision: DecisionRecord = {
          id: rndId(), timestamp: Date.now(),
          reasoning, action, executed,
          agentName: agent.name, agentId: agent.id,
        };

        let delta = 0;
        let newTx: TxRecord | null = null;

        if (action === "airdrop") {
          delta = 0.5;
          const sig = rndSig();
          newTx = { id: rndId(), timestamp: Date.now(), type: "airdrop", amount: 0.5, status: "confirmed", signature: sig, agentName: agent.name, agentId: agent.id, solscanUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet` };
        } else if (action === "transfer" && agent.balance > 0.15) {
          delta = -0.1;
          const peers = prev.filter((a) => a.id !== agent.id);
          const peer = peers[tickRef.current % peers.length];
          const sig = rndSig();
          newTx = { id: rndId(), timestamp: Date.now(), type: "transfer", amount: 0.1, status: "confirmed", signature: sig, from: agent.publicKey, to: peer?.publicKey, agentName: agent.name, agentId: agent.id, solscanUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet` };
        }

        if (newTx) setTxLog((t) => [newTx!, ...t].slice(0, 100));
        setDecisionLog((d) => [decision, ...d].slice(0, 100));

        return {
          ...agent,
          tickCount: agent.tickCount + 1,
          lastTick: Date.now(),
          balance: Math.max(0, agent.balance + delta + (Math.random() - 0.5) * 0.015),
        };
      });
    });
  }, []);

  const ensureInterval = useCallback(() => {
    if (!intervalRef.current) intervalRef.current = setInterval(tick, 3400);
  }, [tick]);

  const clearIfAllStopped = useCallback((updated: AgentSnapshot[]) => {
    if (!updated.some((a) => a.isRunning) && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startAgent = useCallback((id: string) => {
    setAgents((prev) => { const next = prev.map((a) => a.id === id ? { ...a, isRunning: true } : a); ensureInterval(); return next; });
  }, [ensureInterval]);

  const stopAgent = useCallback((id: string) => {
    setAgents((prev) => { const next = prev.map((a) => a.id === id ? { ...a, isRunning: false } : a); clearIfAllStopped(next); return next; });
  }, [clearIfAllStopped]);

  const startAll = useCallback(() => {
    setAgents((prev) => { ensureInterval(); return prev.map((a) => ({ ...a, isRunning: true })); });
  }, [ensureInterval]);

  const stopAll = useCallback(() => {
    setAgents((prev) => { const next = prev.map((a) => ({ ...a, isRunning: false })); clearIfAllStopped(next); return next; });
  }, [clearIfAllStopped]);

  return {
    agents, txLog, decisionLog,
    alerts: [] as AlertRecord[],
    metrics: null as RuntimeMetrics | null,
    status: "simulated" as ConnectionStatus | "simulated",
    startAgent, stopAgent, startAll, stopAll,
    anyRunning: agents.some((a) => a.isRunning),
    totalBalance: agents.reduce((s, a) => s + a.balance, 0),
    totalTxs: txLog.length,
  };
}
