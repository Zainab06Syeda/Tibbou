import { Check, Snowflake, X } from "lucide-react";

import TibbouMark from "@/components/auth/TibbouMark";
import { cn } from "@/lib/utils";

const STATES = {
  idle: { line: "stroke-muted-foreground/40", flow: null, label: "Not connected yet", tone: "text-muted-foreground" },
  ready: { line: "stroke-muted-foreground/40", flow: "lineage-flow", label: "Key ready, waiting for Snowflake", tone: "text-muted-foreground" },
  connecting: { line: "stroke-primary/30", flow: "lineage-flow-active", label: "Connecting to Snowflake…", tone: "text-primary" },
  connected: { line: "stroke-emerald-400", flow: null, label: "Connected", tone: "text-emerald-400" },
  failed: { line: "stroke-red-400/70", flow: null, label: "Couldn't connect", tone: "text-red-300" },
};

// Tibbou on the left, Snowflake on the right, and a line between them that
// shows the connection's state: dashes moving slowly while waiting, quickly
// while validating, solid green once connected, red on failure.
export default function ConnectionDiagram({ state = "idle" }) {
  const config = STATES[state] || STATES.idle;
  return (
    <div className="flex flex-col items-center gap-2 py-2" role="status" aria-live="polite">
      <div className="flex w-full max-w-sm items-center">
        <div
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-border bg-secondary/30 transition-shadow duration-500",
            state === "connected" && "shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
          )}
        >
          <TibbouMark size={7} animated={state === "connecting"} />
        </div>
        <div className="relative h-6 flex-1">
          <svg className="absolute inset-0 h-full w-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 24">
            <line x1="4" y1="12" x2="96" y2="12" strokeWidth="2" vectorEffect="non-scaling-stroke" className={cn("transition-colors duration-500", config.line)} />
            {config.flow ? (
              <line
                x1="4"
                y1="12"
                x2="96"
                y2="12"
                strokeWidth="2"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className={cn("stroke-primary", config.flow)}
              />
            ) : null}
          </svg>
          {state === "connected" || state === "failed" ? (
            <span
              key={state}
              className={cn(
                "absolute left-1/2 top-1/2 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full duration-300 animate-in zoom-in-50",
                state === "connected" ? "bg-emerald-400 text-slate-950" : "bg-red-400 text-slate-950"
              )}
            >
              {state === "connected" ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-border bg-secondary/30 text-sky-300 transition-shadow duration-500",
            state === "connected" && "shadow-[0_0_24px_rgba(125,211,252,0.35)]"
          )}
        >
          <Snowflake className={cn("h-6 w-6", state === "connecting" && "motion-safe:animate-spin motion-safe:[animation-duration:3s]")} />
        </div>
      </div>
      <p className={cn("text-xs font-medium transition-colors duration-300", config.tone)}>{config.label}</p>
    </div>
  );
}
