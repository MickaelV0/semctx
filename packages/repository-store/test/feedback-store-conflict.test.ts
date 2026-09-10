import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFeedbackStoreFile } from "@semantic-context/core";
import { writeFeedbackStore } from "../src";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("feedback store conflicts", () => {
  test("a stale optimistic-concurrency digest has a distinct error code", () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-feedback-conflict-"));
    roots.push(root);
    writeFeedbackStore(root, undefined, emptyFeedbackStoreFile());

    expect(() => writeFeedbackStore(root, "stale", emptyFeedbackStoreFile())).toThrow(expect.objectContaining({
      code: "FEEDBACK_CONFLICT",
    }));
  });
});
