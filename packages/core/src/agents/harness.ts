import type { ForemanConfig, RoleName } from "../config/schema.js";
import type { ForemanBus } from "../events/bus.js";
import type { ProviderMap } from "../providers/factory.js";
import { estimateCostUsd } from "../providers/pricing.js";
import type { Provider } from "../providers/types.js";
import { resolveRoleSlot } from "../router/router.js";
import type { Store } from "../store/db.js";

export interface AgentCall {
  runId: string;
  taskId?: string;
  slot: string;
  role: string; // message-log role: pm | architect | builder | judge | system
  system: string;
  input: string;
  maxTokens?: number;
}

export interface AgentResult {
  output: string;
  model: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The one choke point every model call goes through: slot resolution,
 * provider routing, message logging, cost ledger, event emission.
 * Nothing in the pipeline talks to a provider directly.
 */
export class AgentHarness {
  constructor(
    private readonly config: ForemanConfig,
    private readonly store: Store,
    private readonly bus: ForemanBus,
    private readonly providers: ProviderMap,
    /** Fallback for a `via` missing from the static map — resolves live from
     *  DB-backed API keys (settings UI), so a key added mid-session works
     *  without a restart. Tests never pass this, so their behavior (throw on
     *  a missing provider) is unchanged. */
    private readonly resolveProvider?: (via: string) => Provider | undefined,
  ) {}

  /** The slot currently active for a role (user-preselected default). */
  roleSlot(role: RoleName): string {
    return resolveRoleSlot(this.config, role);
  }

  async run(call: AgentCall): Promise<AgentResult> {
    const slotCfg = this.config.models.slots[call.slot];
    if (!slotCfg) throw new Error(`unknown slot "${call.slot}"`);

    const provider =
      this.providers[slotCfg.via] ?? this.resolveProvider?.(slotCfg.via) ?? this.providers.mock;
    if (!provider) {
      throw new Error(
        `no provider configured for "${slotCfg.via}" (slot "${call.slot}") — add the API key in Settings or .env`,
      );
    }

    this.store.addMessage({
      runId: call.runId,
      taskId: call.taskId,
      role: call.role,
      slot: call.slot,
      content: call.input,
    });
    this.bus.emit({
      type: "agent_call",
      runId: call.runId,
      taskId: call.taskId,
      data: { slot: call.slot, model: slotCfg.model, phase: "start" },
    });

    const result = await provider.chat(
      [
        { role: "system", content: call.system },
        { role: "user", content: call.input },
      ],
      { model: slotCfg.model, maxTokens: call.maxTokens },
    );

    // provider-reported cost wins; otherwise estimate from the price table
    const costUsd =
      result.costUsd > 0
        ? result.costUsd
        : estimateCostUsd(
            result.model,
            result.promptTokens,
            result.completionTokens,
            this.config.prices,
          );

    this.store.addCost({
      runId: call.runId,
      taskId: call.taskId,
      slot: call.slot,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd,
    });
    this.store.addMessage({
      runId: call.runId,
      taskId: call.taskId,
      role: call.role,
      slot: call.slot,
      content: result.content,
    });
    this.bus.emit({
      type: "agent_call",
      runId: call.runId,
      taskId: call.taskId,
      data: {
        slot: call.slot,
        model: result.model,
        phase: "done",
        costUsd,
      },
    });
    this.bus.emit({
      type: "cost",
      runId: call.runId,
      taskId: call.taskId,
      data: { runTotalUsd: this.store.runCost(call.runId) },
    });

    return {
      output: result.content,
      model: result.model,
      costUsd,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    };
  }
}
