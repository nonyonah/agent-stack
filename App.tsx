import { useState } from "react";
import { useAgentWallet, useAgentWalletSimulated } from "./useAgentWallet";
import {
  AgentCard, TxRow, DecisionRow, ConnectionBadge, EmptyState,
  STRATEGY_STYLE,
} from "./components";

type Tab = "transactions" | "decisions";

export default function App() {
  const useSimulated = import.meta.env.VITE_SIMULATED === "true";
  const {
    agents, txLog, decisionLog, status,
    startAgent, stopAgent, startAll, stopAll,
    anyRunning, totalBalance, totalTxs,
  } = useSimulated ? useAgentWalletSimulated() : useAgentWallet();

  const [tab, setTab] = useState<Tab>("transactions");

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=IBM+Plex+Sans:wght@300;400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: #080808; color: #eee; font-family: 'IBM Plex Sans', sans-serif; }
        @keyframes scan     { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes fadeSlide{ from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse    { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0d0d0d; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
        a { color: inherit; }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>

        <header style={{
          borderBottom: "1px solid #141414",
          padding: "13px 28px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: "#080808",
          position: "sticky", top: 0, zIndex: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 16, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em" }}>
              agentstack
            </div>
            <div style={{ fontSize: 9, color: "#444", fontFamily: "monospace", background: "#111", border: "1px solid #1e1e1e", padding: "2px 8px", borderRadius: 4, letterSpacing: "0.1em" }}>
              DEVNET
            </div>
            <ConnectionBadge status={status} />
          </div>

          <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
            <Stat label="total SOL" value={totalBalance.toFixed(3)} />
            <Stat label="txns"      value={String(totalTxs)} />
            <button
              onClick={anyRunning ? stopAll : startAll}
              style={{
                background: anyRunning ? "#1c0a0a" : "#001a0a",
                border: `1px solid ${anyRunning ? "#cc3333" : "#00ff88"}`,
                borderRadius: 8, color: anyRunning ? "#ff6666" : "#00ff88",
                fontFamily: "'Space Mono', monospace", fontSize: 11,
                padding: "8px 18px", cursor: "pointer", letterSpacing: "0.08em",
                transition: "all 0.2s",
              }}
            >
              {anyRunning ? "■  STOP ALL" : "▶  START ALL"}
            </button>
          </div>
        </header>

        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 360px", minHeight: 0 }}>
          <div style={{ padding: "26px 28px", borderRight: "1px solid #111", overflowY: "auto" }}>
            <SectionHeader
              label="agents"
              right={`${agents.filter(a => a.isRunning).length}/${agents.length} running`}
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(255px, 1fr))", gap: 14, marginBottom: 28 }}>
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onStart={() => startAgent(agent.id)}
                  onStop={() => stopAgent(agent.id)}
                />
              ))}
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              {(Object.keys(STRATEGY_STYLE) as Array<keyof typeof STRATEGY_STYLE>).map((s) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <div style={{ width: 7, height: 7, borderRadius: 2, background: STRATEGY_STYLE[s].color }} />
                  <span style={{ fontSize: 9, color: "#3a3a3a", fontFamily: "monospace" }}>{s}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", background: "#0a0a0a", minHeight: 0 }}>
            <div style={{ display: "flex", borderBottom: "1px solid #141414", flexShrink: 0 }}>
              {(["transactions", "decisions"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    flex: 1, padding: "13px 0",
                    background: "none", border: "none",
                    borderBottom: `2px solid ${tab === t ? "#7c6af7" : "transparent"}`,
                    color: tab === t ? "#eee" : "#3a3a3a",
                    fontFamily: "'Space Mono', monospace",
                    fontSize: 10, textTransform: "uppercase",
                    letterSpacing: "0.1em", cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            {anyRunning && (
              <div style={{ padding: "7px 14px", display: "flex", alignItems: "center", gap: 7, borderBottom: "1px solid #111", flexShrink: 0 }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#00ff88", animation: "pulse 1.5s infinite" }} />
                <span style={{ fontSize: 9, color: "#3a3a3a", fontFamily: "monospace", letterSpacing: "0.1em", textTransform: "uppercase" }}>live</span>
              </div>
            )}

            <div style={{ flex: 1, overflowY: "auto" }}>
              {tab === "transactions"
                ? txLog.length === 0
                  ? <EmptyState label="Start agents to see transactions" />
                  : txLog.slice(0, 40).map((tx) => <TxRow key={tx.id} tx={tx} />)
                : decisionLog.length === 0
                  ? <EmptyState label="Start agents to see decisions" />
                  : decisionLog.slice(0, 40).map((d) => <DecisionRow key={d.id} d={d} />)
              }
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 9, color: "#3a3a3a", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</div>
      <div style={{ fontSize: 16, color: "#fff", fontFamily: "'Space Mono', monospace", fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function SectionHeader({ label, right }: { label: string; right?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
      <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: "#3a3a3a", textTransform: "uppercase", letterSpacing: "0.12em" }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: "#141414" }} />
      {right && <span style={{ fontSize: 10, color: "#2a2a2a", fontFamily: "monospace" }}>{right}</span>}
    </div>
  );
}
