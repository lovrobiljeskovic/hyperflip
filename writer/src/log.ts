/** One JSON line per event; `ops/alert-relay.sh` greps these, so keys and order are load-bearing. */
export const logJson = (msg: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg }));

export const logError = (event: string, err: unknown, extra: object = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...extra, error: String((err as Error)?.message).slice(0, 300) }));
