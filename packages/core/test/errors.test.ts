import { describe, expect, it } from "bun:test";
import { SemctxError, attachSuppressedError } from "../src/errors";

describe("attachSuppressedError", () => {
  it("preserves primary Semctx fields and exposes complete cleanup evidence", () => {
    const primary = new SemctxError("ANALYSIS_FAILED", "analysis failed", { stage: "analysis" });
    const cleanup = new SemctxError("STORE_ERROR", "repository store checkpoint is busy", { busy: true });

    const combined = attachSuppressedError(primary, cleanup);

    expect(combined).not.toBe(primary as Error);
    expect(combined.cause).toBe(primary);
    expect(combined.message).toBe("analysis failed");
    expect(combined.suppressed).toEqual([cleanup]);
    expect(combined).toBeInstanceOf(SemctxError);
    if (!(combined instanceof SemctxError)) throw new Error("expected SemctxError wrapper");
    expect(combined.code).toBe("ANALYSIS_FAILED");
    expect(combined.details.suppressed).toEqual([{
      name: "SemctxError",
      code: "STORE_ERROR",
      message: "repository store checkpoint is busy",
      details: { busy: true },
    }]);
  });

  it("wraps frozen errors and frozen Semctx details without masking the primary failure", () => {
    const frozenError = Object.freeze(new Error("frozen primary"));
    const frozenDetails = Object.freeze({ stage: "analysis" });
    const frozenSemctx = new SemctxError("ANALYSIS_FAILED", "frozen Semctx", frozenDetails);

    expect(attachSuppressedError(frozenError, "cleanup").message).toBe("frozen primary");
    const combined = attachSuppressedError(frozenSemctx, "cleanup");
    expect(combined.message).toBe("frozen Semctx");
    expect(combined.cause).toBe(frozenSemctx);
  });

  it("does not overwrite a non-configurable suppressed property and accumulates repeated cleanup failures", () => {
    const primary = new Error("primary");
    Object.defineProperty(primary, "suppressed", {
      configurable: false,
      value: [new Error("existing")],
    });

    const first = attachSuppressedError(primary, new Error("cleanup one"));
    const second = attachSuppressedError(first, new Error("cleanup two"));

    expect(second.suppressed.map((error) => error.message)).toEqual([
      "existing",
      "cleanup one",
      "cleanup two",
    ]);
  });

  it("normalizes primitive failures", () => {
    const combined = attachSuppressedError("primary value", 42);

    expect(combined.message).toBe("primary value");
    expect(combined.suppressed[0]?.message).toBe("42");
  });
});
