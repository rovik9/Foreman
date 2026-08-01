import { EventEmitter } from "node:events";

export interface ForemanEvent {
  type:
    | "run_status"
    | "task_status"
    | "message"
    | "agent_call"
    | "cost"
    | "gate"
    | "judge"
    | "artifact";
  runId: string;
  taskId?: string;
  data: unknown;
  at: string;
}

export type EventHandler = (e: ForemanEvent) => void;

/** One bus per process; server filters by runId for SSE subscribers. */
export class ForemanBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: Omit<ForemanEvent, "at">): void {
    const full: ForemanEvent = { ...event, at: new Date().toISOString() };
    this.emitter.emit("event", full);
    this.emitter.emit(`run:${event.runId}`, full);
  }

  subscribe(runId: string, handler: EventHandler): () => void {
    this.emitter.on(`run:${runId}`, handler);
    return () => this.emitter.off(`run:${runId}`, handler);
  }

  subscribeAll(handler: EventHandler): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}
