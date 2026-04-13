import { describe, expect, it } from "vitest";

import { SpeechQueueManager } from "../src/queue";

describe("SpeechQueueManager", () => {
  it("runs the first request immediately and queues the next one", async () => {
    const manager = new SpeechQueueManager();

    const first = manager.enqueue("First", "alpha.md");
    await expect(first.waitForTurn()).resolves.toBeUndefined();

    const second = manager.enqueue("Second", "beta.md");
    let secondStarted = false;
    const secondTurn = second.waitForTurn().then(() => {
      secondStarted = true;
    });

    await Promise.resolve();

    expect(first.aheadCount).toBe(0);
    expect(second.aheadCount).toBe(1);
    expect(secondStarted).toBe(false);
    expect(manager.getPendingCount()).toBe(1);

    const itemsWhileQueued = manager.getChildren();
    expect(itemsWhileQueued[0].description).toBe("1 running · 1 queued");
    expect(itemsWhileQueued[1].label).toBe("First");
    expect(itemsWhileQueued[2].label).toBe("Second");

    first.finish();
    await secondTurn;

    expect(secondStarted).toBe(true);

    second.finish();
    expect(manager.getChildren()[0].label).toBe("Queue empty");
  });

  it("can cancel a queued request before it starts", async () => {
    const manager = new SpeechQueueManager();

    const active = manager.enqueue("First", "alpha.md");
    await active.waitForTurn();

    const queued = manager.enqueue("Second", "beta.md");
    const queuedTurn = queued.waitForTurn();

    expect(queued.cancelQueued()).toBe(true);
    await expect(queuedTurn).rejects.toThrow("Kokoros request removed from queue.");
    expect(manager.getPendingCount()).toBe(0);

    active.finish();
  });

  it("clears every queued request and reports how many were removed", async () => {
    const manager = new SpeechQueueManager();

    const active = manager.enqueue("First", "alpha.md");
    await active.waitForTurn();

    const queuedOne = manager.enqueue("Second", "beta.md");
    const queuedTwo = manager.enqueue("Third", "gamma.md");

    const pendingTurns = [
      queuedOne.waitForTurn(),
      queuedTwo.waitForTurn()
    ];

    expect(manager.clearPending()).toBe(2);
    await Promise.all(pendingTurns.map((turn) => expect(turn).rejects.toThrow("Kokoros request removed from queue.")));

    active.finish();
  });

  it("ignores invalid removals and finishing inactive tickets", async () => {
    const manager = new SpeechQueueManager();

    const first = manager.enqueue("First", "alpha.md");
    await first.waitForTurn();

    const second = manager.enqueue("Second", "beta.md");

    expect(manager.removeQueued("missing")).toBe(false);

    second.finish();
    expect(manager.getPendingCount()).toBe(1);

    first.finish();
    await expect(second.waitForTurn()).resolves.toBeUndefined();
    second.finish();
  });
});
