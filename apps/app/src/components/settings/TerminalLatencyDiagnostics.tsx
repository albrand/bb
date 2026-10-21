import { useEffect, useState } from "react";
import {
  getTerminalLatencyDiagnostics,
  type TerminalLatencyDiagnosticsSnapshot,
} from "@/components/thread/terminal/terminal-latency-diagnostics.js";

function metricText(
  count: number,
  totalCount: number,
  p50Ms: number | null,
  p95Ms: number | null,
) {
  if (count === 0 || p50Ms === null || p95Ms === null) return "No samples yet";
  return `n=${count} (total ${totalCount}) · p50 ${p50Ms.toFixed(1)} ms · p95 ${p95Ms.toFixed(1)} ms`;
}

export function TerminalLatencyDiagnostics() {
  const [snapshot, setSnapshot] = useState<TerminalLatencyDiagnosticsSnapshot>(
    getTerminalLatencyDiagnostics,
  );

  useEffect(() => {
    const timer = window.setInterval(
      () => setSnapshot(getTerminalLatencyDiagnostics()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="space-y-2 text-sm"
      aria-label="Terminal latency diagnostics"
    >
      {(["desktop", "phone"] as const).map((formFactor) => (
        <div key={formFactor}>
          <div className="font-medium capitalize">{formFactor}</div>
          <div>
            Input event to transport enqueue:{" "}
            {metricText(
              snapshot[formFactor].inputEventToEnqueueMs.count,
              snapshot[formFactor].inputEventToEnqueueMs.totalCount,
              snapshot[formFactor].inputEventToEnqueueMs.p50Ms,
              snapshot[formFactor].inputEventToEnqueueMs.p95Ms,
            )}
          </div>
          <div>
            Transport enqueue to WebSocket send:{" "}
            {metricText(
              snapshot[formFactor].inputEnqueueToWebSocketSendMs.count,
              snapshot[formFactor].inputEnqueueToWebSocketSendMs.totalCount,
              snapshot[formFactor].inputEnqueueToWebSocketSendMs.p50Ms,
              snapshot[formFactor].inputEnqueueToWebSocketSendMs.p95Ms,
            )}
          </div>
          <div>
            Key sent → first output:{" "}
            {metricText(
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .count,
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .totalCount,
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .p50Ms,
              snapshot[formFactor].inputWebSocketSendToFirstOutputReceivedMs
                .p95Ms,
            )}
          </div>
          <div>
            Transport enqueue → first output:{" "}
            {metricText(
              snapshot[formFactor].inputToFirstOutputReceivedMs.count,
              snapshot[formFactor].inputToFirstOutputReceivedMs.totalCount,
              snapshot[formFactor].inputToFirstOutputReceivedMs.p50Ms,
              snapshot[formFactor].inputToFirstOutputReceivedMs.p95Ms,
            )}
          </div>
          <div>
            First output → rendered:{" "}
            {metricText(
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs.count,
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs
                .totalCount,
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs.p50Ms,
              snapshot[formFactor].inputFirstOutputReceivedToRenderMs.p95Ms,
            )}
          </div>
          <div>
            Key → first output rendered:{" "}
            {metricText(
              snapshot[formFactor].inputToFirstOutputRenderMs.count,
              snapshot[formFactor].inputToFirstOutputRenderMs.totalCount,
              snapshot[formFactor].inputToFirstOutputRenderMs.p50Ms,
              snapshot[formFactor].inputToFirstOutputRenderMs.p95Ms,
            )}
          </div>
          <div>
            Output receive to render:{" "}
            {metricText(
              snapshot[formFactor].outputRenderMs.count,
              snapshot[formFactor].outputRenderMs.totalCount,
              snapshot[formFactor].outputRenderMs.p50Ms,
              snapshot[formFactor].outputRenderMs.p95Ms,
            )}
          </div>
        </div>
      ))}
      <p className="text-muted-foreground">
        Timings are sampled in memory. Terminal input and output contents are
        not recorded.
      </p>
    </div>
  );
}
