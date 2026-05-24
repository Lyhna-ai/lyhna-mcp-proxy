import type { BindResponse } from "./bind.js";

export type ForwardDecision = "FORWARD" | "HOLD_AWAIT_RESOLUTION" | "FAIL_CLOSED";

export function decideForward(result: BindResponse): ForwardDecision {
  switch (result.outcome) {
    case "APPROVED":
      return "FORWARD";
    case "ESCALATED":
      return "HOLD_AWAIT_RESOLUTION";
    case "REFUSED":
    default:
      return "FAIL_CLOSED";
  }
}
