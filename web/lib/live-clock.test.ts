import { afterEach, expect, test, vi } from "vitest";
import { subscribeNow } from "../app/live";

afterEach(() => vi.useRealTimers());

test("subscribeNow runs one interval for all subscribers and stops it with the last", () => {
  vi.useFakeTimers();
  const a = vi.fn();
  const b = vi.fn();
  const offA = subscribeNow(a);
  const offB = subscribeNow(b);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledWith(a.mock.calls[0][0]);
  offA();
  expect(vi.getTimerCount()).toBe(1);
  offB();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(1000);
  expect(b).toHaveBeenCalledTimes(1);
});

test("subscribeNow restarts the interval when a subscriber returns after the last left", () => {
  vi.useFakeTimers();
  subscribeNow(vi.fn())();
  expect(vi.getTimerCount()).toBe(0);
  const off = subscribeNow(vi.fn());
  expect(vi.getTimerCount()).toBe(1);
  off();
});
