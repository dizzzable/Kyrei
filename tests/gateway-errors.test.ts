import { describe, expect, it } from "vitest";

import { requestErrorStatus } from "../core/gateway.js";

describe("gateway error status contract", () => {
  it.each([
    ["pipeline_run_state_corrupt", 500],
    ["workspace_lease_state_invalid", 500],
    ["pipeline_run_store_busy", 503],
    ["workspace_lease_lock_busy", 503],
    ["pipeline_run_terminal", 409],
    ["pipeline_stage_active", 409],
    ["pipeline_runtime_unavailable", 409],
    ["pipeline_id_required", 400],
    ["gbrain_command_unavailable", 503],
    ["gbrain_initialization_unavailable", 409],
    ["gbrain_initialization_failed", 502],
  ])("maps %s to %i", (code, status) => {
    expect(requestErrorStatus(new Error(code))).toBe(status);
  });
});
