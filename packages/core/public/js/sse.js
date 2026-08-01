/** SSE wrapper — one EventSource per active run, fan-out to listeners. */

const listeners = new Map(); // eventType -> Set<fn>
let source = null;

export const sse = {
  attach(runId) {
    sse.close();
    source = new EventSource(`/runs/${runId}/events`);
    for (const type of listeners.keys()) {
      source.addEventListener(type, (m) => {
        const e = JSON.parse(m.data);
        for (const fn of listeners.get(type)) fn(e);
      });
    }
  },
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    if (source) {
      source.addEventListener(type, (m) => {
        const e = JSON.parse(m.data);
        fn(e);
      });
    }
  },
  close() {
    source?.close();
    source = null;
  },
};
