import type { AgentSnapshot, TxRecord, DecisionRecord } from "./useAgentWallet";

// ─── Constants ────────────────────────────────────────────────────────────────

export const STRATEGY_STYLE = {
  ACCUMULATE: { color: "#00ff88", bg: "#0a2a1a", border: "#00ff88" },
  DISTRIBUTE:  { color: "#a89ff5", bg: "#1a1a2e", border: "#7c6af7" },
  PATROL:      { color: "#ffaa44", bg: "#2a1a0a", border: "#ff8c00" },
} as const;

export const TX_ICON  = { airdrop: "⬇", transfer: "→", swap: "⇄", custom: "◆" } as const;
export const TX_COLOR = { airdrop: "#00ff88", transfer: "#7c6af7", swap: "#ff8c00", custom: "#666" } as const;
export const STATUS_COLOR = { confirmed: "#00ff88", failed: "#ff4444", pending: "#ffaa00" } as const;

// ─── Utils ────────────────────────────────────────────────────────────────────

export function trunc(s = "", n = 8) {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}...${s.slice(-4)}`;
}

export function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ─── AgentCard ─────────────────────────────────────────────────────────────────

interface AgentCardProps {
  agent: AgentSnapshot;
  onStart: () => void;
  onStop: () => void;
}

export function AgentCard({ agent, onStart, onStop }: AgentCardProps) {
  const st = STRATEGY_STYLE[agent.strategy];

  return (
    <div style={{
      background: "#0d0d0d",
      border: `1px solid ${agent.isRunning ? st.border : "#1e1e1e"}`,
      borderRadius: 12,
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 14,
      position: "relative",
      overflow: "hidden",
      transition: "border-color 0.4s, box-shadow 0.4s",
      boxShadow: agent.isRunning ? `0 0 20px ${st.color}18` : "none",
    }}>
      {/* Scan bar */}
      {agent.isRunning && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 2,
          background: `linear-gradient(90deg, transparent, ${st.color}, transparent)`,
          animation: "scan 2s linear infinite",
        }} />
      )}

      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: agent.isRunning ? st.color : "#2a2a2a",
              boxShadow: agent.isRunning ? `0 0 8px ${st.color}` : "none",
              transition: "all 0.4s",
            }} />
            <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 14, fontWeight: 700, color: "#eee" }}>
              {agent.name}
            </span>
          </div>
          <a
            href={agent.solscanUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontFamily: "monospace", fontSize: 10, color: "#3a3a3a", textDecoration: "none", letterSpacing: "0.04em" }}
            title={agent.publicKey}
          >
            {trunc(agent.publicKey, 10)} ↗
          </a>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <div style={{
            background: st.bg, border: `1px solid ${st.border}`,
            borderRadius: 5, padding: "2px 8px",
            fontSize: 9, color: st.color, fontFamily: "monospace", letterSpacing: "0.1em",
          }}>
            {agent.strategy}
          </div>
          <div style={{ fontSize: 9, color: "#333", fontFamily: "monospace" }}>tick #{agent.tickCount}</div>
        </div>
      </div>

      {/* Balance */}
      <div style={{ background: "#111", borderRadius: 8, padding: "12px 14px" }}>
        <div style={{ fontSize: 9, color: "#444", fontFamily: "monospace", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          balance
        </div>
        <div style={{ fontSize: 26, color: "#fff", fontFamily: "'Space Mono', monospace", fontWeight: 700, letterSpacing: "-0.03em" }}>
          {agent.balance.toFixed(4)}
          <span style={{ fontSize: 12, color: "#555", marginLeft: 6 }}>SOL</span>
        </div>
      </div>

      {/* CTA */}
      <button
        onClick={agent.isRunning ? onStop : onStart}
        style={{
          background: agent.isRunning ? "#1c0a0a" : "#0a1a0a",
          border: `1px solid ${agent.isRunning ? "#cc3333" : st.border}`,
          borderRadius: 8,
          color: agent.isRunning ? "#ff6666" : st.color,
          fontFamily: "'Space Mono', monospace",
          fontSize: 11, padding: "9px 0",
          cursor: "pointer", width: "100%",
          letterSpacing: "0.08em",
          transition: "all 0.2s",
        }}
      >
        {agent.isRunning ? "■  STOP AGENT" : "▶  START AGENT"}
      </button>
    </div>
  );
}

// ─── TxRow ────────────────────────────────────────────────────────────────────

export function TxRow({ tx }: { tx: TxRecord }) {
  const icon = TX_ICON[tx.type] ?? "◆";
  const color = TX_COLOR[tx.type] ?? "#666";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 11,
      padding: "9px 14px", borderBottom: "1px solid #0f0f0f",
      animation: "fadeSlide 0.3s ease",
    }}>
      <span style={{ fontSize: 13, color, width: 16, textAlign: "center", flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>{tx.agentName}</span>
          <span style={{ fontSize: 10, color, fontFamily: "monospace" }}>{tx.type}</span>
          {tx.amount != null && (
            <span style={{ fontSize: 10, color: "#ccc", fontFamily: "monospace" }}>{tx.amount} SOL</span>
          )}
        </div>
        {tx.signature && (
          <div style={{ marginTop: 2 }}>
            {tx.solscanUrl ? (
              <a href={tx.solscanUrl} target="_blank" rel="noreferrer"
                style={{ fontSize: 9, color: "#2e2e4a", fontFamily: "monospace", textDecoration: "none" }}
                title={tx.signature}
              >
                {trunc(tx.signature, 14)} ↗
              </a>
            ) : (
              <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace" }}>
                {trunc(tx.signature, 14)}
              </span>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: 8, color: "#2a2a2a", fontFamily: "monospace", whiteSpace: "nowrap" }}>
        {ago(tx.timestamp)}
      </div>
      <div style={{
        width: 5, height: 5, borderRadius: "50%",
        background: STATUS_COLOR[tx.status] ?? "#666",
        flexShrink: 0,
      }} />
    </div>
  );
}

// ─── DecisionRow ──────────────────────────────────────────────────────────────

export function DecisionRow({ d }: { d: DecisionRecord }) {
  return (
    <div style={{
      padding: "10px 14px", borderBottom: "1px solid #0f0f0f",
      animation: "fadeSlide 0.3s ease",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "#7c6af7", fontFamily: "monospace" }}>{d.agentName}</span>
        <span style={{ fontSize: 8, color: "#2a2a2a", fontFamily: "monospace" }}>{ago(d.timestamp)}</span>
      </div>
      <div style={{ fontSize: 10, color: "#666", fontFamily: "monospace", lineHeight: 1.55 }}>
        {d.reasoning}
      </div>
      <div style={{ marginTop: 4, fontSize: 9, color: d.executed ? "#00ff88" : "#3a3a3a", fontFamily: "monospace" }}>
        {d.executed ? "✓" : "○"} {d.action}
      </div>
    </div>
  );
}

// ─── ConnectionBadge ──────────────────────────────────────────────────────────

export function ConnectionBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    connected:    { color: "#00ff88", label: "LIVE" },
    connecting:   { color: "#ffaa00", label: "CONNECTING" },
    disconnected: { color: "#ff4444", label: "DISCONNECTED" },
    error:        { color: "#ff4444", label: "ERROR" },
    simulated:    { color: "#7c6af7", label: "SIMULATED" },
  };
  const cfg = map[status] ?? map.simulated;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: cfg.color,
        animation: status === "connected" || status === "simulated" ? "pulse 2s infinite" : "none",
      }} />
      <span style={{ fontSize: 9, color: cfg.color, fontFamily: "monospace", letterSpacing: "0.1em" }}>
        {cfg.label}
      </span>
    </div>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

export function EmptyState({ label }: { label: string }) {
  return (
    <div style={{ padding: 32, textAlign: "center", color: "#2a2a2a", fontFamily: "monospace", fontSize: 12 }}>
      {label}
    </div>
  );
}
