import { beforeEach, describe, expect, test, vi } from "vitest";
import { deliver } from "../src/adapters/outbound/deliver.js";
import { deliverCommandResult } from "../src/core/delivery.js";
import { readRecord, writeRecord } from "../src/core/idempotency.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", async (orig) => ({
  ...(await orig<typeof import("../src/adapters/outbound/garmin-ipc-inbound.js")>()),
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));
const sendReplyMock = vi.mocked(sendReply);

let env: Env;
beforeEach(() => {
  env = makeTestEnv();
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deliver — media seam (#268)", () => {
  test("pages go to sendReply", async () => {
    await deliver("123456789012345", { pages: ["hello"] }, env);
    expect(sendReplyMock).toHaveBeenCalledWith("123456789012345", ["hello"], env);
  });

  test("media is not implemented yet and says so", async () => {
    await expect(
      deliver(
        "123456789012345",
        { pages: [], media: { mimeType: "image/avif", bytes: new ArrayBuffer(1) } },
        env,
      ),
    ).rejects.toThrow(/not implemented \(#285\)/);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });
});

describe("deliverCommandResult (#268)", () => {
  test("builds the reply, sends it, and completes the record", async () => {
    await writeRecord(env, "k", { status: "processing", receivedAt: 1 });
    const ok = await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    expect(ok).toBe(true);
    expect(sendReplyMock).toHaveBeenCalledWith("123456789012345", ["pong"], env);
    expect((await readRecord(env, "k"))?.status).toBe("completed");
  });

  test("a send failure returns false and leaves the record not completed", async () => {
    await writeRecord(env, "k", { status: "processing", receivedAt: 1 });
    sendReplyMock.mockRejectedValueOnce(new Error("IPC 503"));
    const ok = await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    expect(ok).toBe(false);
    expect((await readRecord(env, "k"))?.status).toBe("processing");
  });

  test("a second call after a sent reply does not send again (reply checkpoint)", async () => {
    await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });
});
