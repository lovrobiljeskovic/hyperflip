// ops/alert-relay.sh greps ALERT|FATAL|watchdog-stalled from these lines, so those tokens are load-bearing; JSON key order is otherwise free.
export const logJson = (msg: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg }));

export const logError = (event: string, err: unknown, extra: object = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...extra, error: String((err as Error)?.message).slice(0, 300) }));

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

export function alert(...args: unknown[]): void {
  console.error(new Date().toISOString(), "ALERT", ...args);
}
