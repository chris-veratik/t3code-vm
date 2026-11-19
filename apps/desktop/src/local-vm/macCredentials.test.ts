import { expect, it, vi } from "@effect/vitest";
import { createCodexSubscription } from "./macCredentials.ts";

const fresh = (account: string, token: string) => ({
  tokens: { chatgptAccountId: account, accessToken: token },
  expires: 4_102_444_800_000,
});

it("coalesces guest refreshes after a pending Mac account read and keeps the workspace pinned", async () => {
  const read = Promise.withResolvers<ReturnType<typeof fresh>>();
  const refresh = Promise.withResolvers<ReturnType<typeof fresh>>();
  const started = Promise.withResolvers<void>();
  const source = vi.fn((force: boolean) => {
    if (!force) return read.promise;
    started.resolve();
    return refresh.promise;
  });
  const subscription = createCodexSubscription(source);
  const first = subscription.issue(false, null);
  const retries = [subscription.issue(true, "work"), subscription.issue(true, "work")];
  expect(source.mock.calls).toEqual([[false]]);
  read.resolve(fresh("work", "first"));
  expect(await first).toEqual(fresh("work", "first").tokens);
  await started.promise;
  refresh.resolve(fresh("work", "refreshed"));
  expect(await Promise.all(retries)).toEqual([
    fresh("work", "refreshed").tokens,
    fresh("work", "refreshed").tokens,
  ]);
  await expect(subscription.issue(true, "other")).rejects.toThrow("different ChatGPT workspace");
  expect(source.mock.calls).toEqual([[false], [true]]);
});

it("refreshes an expired access token on the Mac before handing a guest its first token", async () => {
  const source = vi.fn((force: boolean) =>
    Promise.resolve(force ? fresh("work", "new") : { ...fresh("work", "old"), expires: 0 }),
  );
  const subscription = createCodexSubscription(source);
  expect(await subscription.issue(false, null)).toEqual(fresh("work", "new").tokens);
  expect(source.mock.calls).toEqual([[false], [true]]);
});
