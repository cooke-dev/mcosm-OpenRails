import type { ActionDescriptorV1, AuthorityMode } from "./types.js";

const authorityRank: Record<AuthorityMode, number> = {
  observe: 0,
  propose: 1,
  prepare: 2,
  confirmed_execution: 3,
};

export function authorityModeSatisfies(actual: AuthorityMode, required: AuthorityMode): boolean {
  return authorityRank[actual] >= authorityRank[required];
}

export const DEFAULT_ACTIONS: readonly ActionDescriptorV1[] = [
  {
    version: "openrails-action-v1",
    actionType: "read_state",
    description: "Read Workspace, Agent, Path, Pact, checkpoint, or payment state.",
    riskClass: "read",
    minimumAuthorityMode: "observe",
    executor: "runtime",
    paymentEffect: "none",
    allowedTargets: [],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "create_pact_proposal",
    description: "Create a non-authorizing Pact proposal.",
    riskClass: "proposal",
    minimumAuthorityMode: "propose",
    executor: "runtime",
    paymentEffect: "none",
    allowedTargets: [],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "request_quote",
    description: "Request or normalize non-authorizing commercial terms.",
    riskClass: "proposal",
    minimumAuthorityMode: "propose",
    executor: "runtime",
    paymentEffect: "none",
    allowedTargets: [],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "prepare_railsflow",
    description: "Prepare an unsigned bounded OpenRails RailsFlow.",
    riskClass: "prepare",
    minimumAuthorityMode: "prepare",
    executor: "wallet",
    paymentEffect: "prepare_only",
    allowedTargets: ["0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1"],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "recommend_settlement",
    description: "Recommend a public settlement checkpoint without redirecting funds.",
    riskClass: "prepare",
    minimumAuthorityMode: "prepare",
    executor: "public-caller",
    paymentEffect: "prepare_only",
    allowedTargets: ["0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1"],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "recommend_close",
    description: "Recommend residual closure through the fixed OpenRails Paycard terms.",
    riskClass: "prepare",
    minimumAuthorityMode: "prepare",
    executor: "wallet",
    paymentEffect: "prepare_only",
    allowedTargets: ["0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1"],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "open_payment",
    description: "Open an OpenRails Paycard after external-wallet confirmation.",
    riskClass: "financial",
    minimumAuthorityMode: "confirmed_execution",
    executor: "wallet",
    paymentEffect: "moves_value",
    allowedTargets: ["0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1"],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "submit_checkpoint",
    description: "Submit an execution checkpoint for plugin verification.",
    riskClass: "proposal",
    minimumAuthorityMode: "propose",
    executor: "runtime",
    paymentEffect: "none",
    allowedTargets: [],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "open_gaia_request",
    description: "Open a non-financial Gaia review request.",
    riskClass: "proposal",
    minimumAuthorityMode: "propose",
    executor: "runtime",
    paymentEffect: "none",
    allowedTargets: [],
    allowedSelectors: [],
    enabled: true,
  },
  {
    version: "openrails-action-v1",
    actionType: "update_path",
    description: "Administrative Path revision. Agents may never self-authorize it.",
    riskClass: "administrative",
    minimumAuthorityMode: "confirmed_execution",
    executor: "wallet",
    paymentEffect: "none",
    allowedTargets: [],
    allowedSelectors: [],
    enabled: true,
  },
];

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDescriptorV1>();

  constructor(actions: readonly ActionDescriptorV1[] = DEFAULT_ACTIONS) {
    for (const action of actions) this.register(action);
  }

  register(action: ActionDescriptorV1): void {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(action.actionType)) throw new Error("invalid actionType");
    const existing = this.actions.get(action.actionType);
    if (existing && JSON.stringify(existing) !== JSON.stringify(action)) throw new Error(`action ${action.actionType} already registered with different terms`);
    this.actions.set(action.actionType, structuredClone(action));
  }

  get(actionType: string): ActionDescriptorV1 | undefined {
    const action = this.actions.get(actionType);
    return action ? structuredClone(action) : undefined;
  }

  list(): ActionDescriptorV1[] {
    return Array.from(this.actions.values()).map((action) => structuredClone(action));
  }
}
