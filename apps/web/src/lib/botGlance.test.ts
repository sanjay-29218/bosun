import { describe, expect, it, vi } from "vite-plus/test";

import { createBotGlanceScheduler } from "./botGlance";

function setup() {
  vi.useFakeTimers();
  const state = { visible: true, reducedMotion: false };
  const listeners = new Set<() => void>();
  const scheduler = createBotGlanceScheduler({
    visible: () => state.visible,
    reducedMotion: () => state.reducedMotion,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    // Every gap is the shortest, 5s.
    random: () => 0,
  });
  const avatar = () => {
    const target = {
      glances: [] as string[],
      glancing: false,
      setAttribute: (name: string) => {
        target.glances.push(name);
        target.glancing = true;
      },
      removeAttribute: () => {
        target.glancing = false;
      },
    };
    return target;
  };
  const change = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    for (const listener of listeners) listener();
  };
  return {
    scheduler,
    avatar,
    change,
    listeners,
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

describe("createBotGlanceScheduler", () => {
  it("glances each working avatar on its own gap with one timer for all", () => {
    using env = setup();
    const first = env.avatar();
    const second = env.avatar();
    env.scheduler.register(first);
    vi.advanceTimersByTime(2_000);
    env.scheduler.register(second);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3_000);
    expect(first.glances).toEqual(["data-glance"]);
    expect(second.glances).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(second.glances).toEqual(["data-glance"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops glancing once unregistered and leaves no timer or listener", () => {
    using env = setup();
    const avatar = env.avatar();
    env.scheduler.register(avatar);
    env.scheduler.unregister(avatar);
    vi.advanceTimersByTime(20_000);
    expect(avatar.glances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(env.listeners.size).toBe(0);
  });

  it("holds still while the document is hidden and restarts when it shows", () => {
    using env = setup();
    const avatar = env.avatar();
    env.scheduler.register(avatar);
    env.change({ visible: false });
    vi.advanceTimersByTime(20_000);
    expect(avatar.glances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    env.change({ visible: true });
    vi.advanceTimersByTime(5_000);
    expect(avatar.glances).toEqual(["data-glance"]);
  });

  it.each([
    ["the document hides", { visible: false }, { visible: true }],
    ["reduced motion turns on", { reducedMotion: true }, { reducedMotion: false }],
  ] as const)("stops a glance under way when %s, then resumes", (_, stop, resume) => {
    using env = setup();
    const avatar = env.avatar();
    env.scheduler.register(avatar);
    vi.advanceTimersByTime(5_000);
    expect(avatar.glancing).toBe(true);

    env.change(stop);
    expect(avatar.glancing).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(avatar.glances).toEqual(["data-glance"]);
    expect(vi.getTimerCount()).toBe(0);

    env.change(resume);
    vi.advanceTimersByTime(5_000);
    expect(avatar.glances).toEqual(["data-glance", "data-glance"]);
    expect(avatar.glancing).toBe(true);
  });

  it("never glances with reduced motion", () => {
    using env = setup();
    env.change({ reducedMotion: true });
    const avatar = env.avatar();
    env.scheduler.register(avatar);
    vi.advanceTimersByTime(20_000);
    expect(avatar.glances).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
