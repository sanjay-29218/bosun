import { getDocumentActivity, subscribeDocumentActivity } from "./documentActivity";

const MIN_GAP_MS = 5_000;
const MAX_GAP_MS = 9_000;

export interface BotGlanceTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface BotGlanceEnvironment {
  readonly visible: () => boolean;
  readonly reducedMotion: () => boolean;
  /** Calls back when either of the above may have changed. */
  readonly subscribe: (onChange: () => void) => () => void;
  readonly random: () => number;
}

/**
 * Makes working avatars glance now and then. Every avatar keeps its own next time, offset at
 * random, and one timer for the whole app wakes for the earliest; the glance itself is a
 * one-shot CSS animation started by `data-glance`, which the avatar clears on `animationend`.
 */
export function createBotGlanceScheduler(environment: BotGlanceEnvironment) {
  const due = new Map<BotGlanceTarget, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const gap = () => MIN_GAP_MS + environment.random() * (MAX_GAP_MS - MIN_GAP_MS);
  const canMove = () => environment.visible() && !environment.reducedMotion();

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (due.size === 0 || !canMove()) return;
    const next = Math.min(...due.values());
    timer = setTimeout(tick, Math.max(0, next - Date.now()));
  };

  const tick = () => {
    timer = null;
    const now = Date.now();
    for (const [target, at] of due) {
      if (at > now) continue;
      target.setAttribute("data-glance", "");
      due.set(target, now + gap());
    }
    schedule();
  };

  let moving = false;
  const onEnvironmentChange = () => {
    const was = moving;
    moving = canMove();
    // Times kept while still are stale; restart every avatar with a fresh offset.
    if (moving && !was) {
      const now = Date.now();
      for (const target of due.keys()) due.set(target, now + gap());
    }
    // Stop a glance already under way, not just the next one.
    if (!moving && was) {
      for (const target of due.keys()) target.removeAttribute("data-glance");
    }
    schedule();
  };

  return {
    register(target: BotGlanceTarget) {
      if (due.has(target)) return;
      due.set(target, Date.now() + gap());
      if (unsubscribe === null) {
        moving = canMove();
        unsubscribe = environment.subscribe(onEnvironmentChange);
      }
      schedule();
    },
    unregister(target: BotGlanceTarget) {
      if (!due.delete(target)) return;
      target.removeAttribute("data-glance");
      if (due.size === 0) {
        unsubscribe?.();
        unsubscribe = null;
      }
      schedule();
    },
  };
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

let shared: ReturnType<typeof createBotGlanceScheduler> | null = null;

export function botGlanceScheduler() {
  shared ??= createBotGlanceScheduler({
    visible: () => getDocumentActivity().visible,
    reducedMotion: () => window.matchMedia(REDUCED_MOTION).matches,
    subscribe: (onChange) => {
      const motion = window.matchMedia(REDUCED_MOTION);
      motion.addEventListener("change", onChange);
      const stopActivity = subscribeDocumentActivity(onChange);
      return () => {
        motion.removeEventListener("change", onChange);
        stopActivity();
      };
    },
    random: Math.random,
  });
  return shared;
}
