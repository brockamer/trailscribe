/** Fake ExecutionContext that collects `waitUntil` promises so tests can await them. */
export function makeExecCtx(): {
  ctx: ExecutionContext;
  drain: () => Promise<void>;
  count: () => number;
} {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    drain: async () => {
      await Promise.all(tasks);
    },
    count: () => tasks.length,
  };
}
