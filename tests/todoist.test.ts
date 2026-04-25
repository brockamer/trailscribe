import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { addTask, TodoistError } from "../src/adapters/tasks/todoist.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
let fetchSpy: MockInstance<typeof fetch>;

const noDelay = () => Promise.resolve();

beforeEach(() => {
  env = makeTestEnv();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("addTask — happy path", () => {
  test("with lat/lon: description includes coords + ISO timestamp; returns id + URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, { id: "t_8675309", content: "buy waterfilter cartridge" }),
    );

    const result = await addTask({
      task: "buy waterfilter cartridge",
      lat: 37.1682,
      lon: -118.5891,
      timestamp: 1739802015000,
      env,
      delay: noDelay,
    });

    expect(result).toEqual({
      id: "t_8675309",
      url: "https://todoist.com/showTask?id=t_8675309",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.todoist.com/rest/v2/tasks");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${env.TODOIST_API_TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.content).toBe("buy waterfilter cartridge");
    expect(body.description).toContain("From inReach");
    expect(body.description).toContain("37.1682,-118.5891");
    expect(body.description).toContain("2025-02-17");
    expect(body.due_string).toBeUndefined();
  });

  test("without lat/lon: description omits coords; only timestamp shown", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: "t_x" }));

    await addTask({
      task: "follow up",
      timestamp: 1739802015000,
      env,
      delay: noDelay,
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.description).toBe("From inReach — sent 2025-02-17T14:20:15.000Z");
    expect(body.description).not.toContain(",");
  });
});

describe("addTask — error paths", () => {
  test("401 bad token surfaces TodoistError", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(401, { error: "AUTH_INVALID_TOKEN" }),
    );

    let caught: unknown;
    try {
      await addTask({
        task: "x",
        timestamp: 0,
        env,
        delay: noDelay,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TodoistError);
    expect((caught as TodoistError).status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("403 forbidden also surfaced (not retried)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { error: "Forbidden" }));
    await expect(
      addTask({ task: "x", timestamp: 0, env, delay: noDelay }),
    ).rejects.toBeInstanceOf(TodoistError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("5xx retried at 1s/4s/16s, success on third attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "t_99" }));

    const sleeps: number[] = [];
    const recordingDelay = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    const result = await addTask({
      task: "x",
      timestamp: 0,
      env,
      delay: recordingDelay,
    });
    expect(result.id).toBe("t_99");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
  });

  test("network error retried", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(jsonResponse(200, { id: "t_1" }));
    const r = await addTask({ task: "x", timestamp: 0, env, delay: noDelay });
    expect(r.id).toBe("t_1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
