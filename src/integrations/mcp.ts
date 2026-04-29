import type { ToolCall, ToolCallDraft, ToolCallStatus } from "../models";
import { getCurrentTrace, type TraceBuilder } from "../tracing";
import { normalizeError } from "../utils";

export type MCPTransport = "stdio" | "sse" | "http";

export interface MCPToolCall {
  server: string;
  tool: string;
  transport?: MCPTransport;
  arguments?: unknown;
  result?: unknown;
  status?: ToolCallStatus;
  startedAt?: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
}

function toDraft(call: MCPToolCall): ToolCallDraft {
  return {
    type: "tool_call",
    toolName: `${call.server}.${call.tool}`,
    input: call.arguments,
    output: call.result,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    status: call.status ?? (call.error ? "error" : "ok"),
    metadata: {
      ...call.metadata,
      mcp: {
        server: call.server,
        tool: call.tool,
        transport: call.transport ?? "stdio",
      },
    },
    error: call.error ? normalizeError(call.error) : undefined,
  };
}

export function createMCPToolCall(call: MCPToolCall): ToolCallDraft {
  return toDraft(call);
}

export function recordMCPToolCall(
  call: MCPToolCall,
  trace?: TraceBuilder,
): ToolCall {
  const activeTrace = trace ?? getCurrentTrace();
  if (!activeTrace) {
    throw new Error(
      "No active trace available. Pass a TraceBuilder or call inside traceAgentRun().",
    );
  }

  return activeTrace.recordEvent(toDraft(call)) as ToolCall;
}
