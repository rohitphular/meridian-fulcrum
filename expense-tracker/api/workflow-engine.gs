// =============================================================================
// FULCRUM FORGE — Workflow Engine
// Maps workflow_type → ordered step sequence. Executes and reverses steps
// against an account balance context. No sheet I/O.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Step catalogue
// ctx shape: { source_account, target_account, amount, to_amount, fx_rate }
// to_amount = amount credited to target; caller resolves FX (equals amount for
// same-currency transfers).
// ─────────────────────────────────────────────────────────────────────────────
const WORKFLOW_STEPS = {
  'deduct-source': {
    forward: function(ctx) { adjustAccountBalance(ctx.source_account, -ctx.amount); },
    inverse: function(ctx) { adjustAccountBalance(ctx.source_account, +ctx.amount); },
  },
  'add-target': {
    forward: function(ctx) { adjustAccountBalance(ctx.target_account, +ctx.to_amount); },
    inverse: function(ctx) { adjustAccountBalance(ctx.target_account, -ctx.to_amount); },
  },
  'reduce-liability': {
    // Liability accounts hold a negative balance; adding positive reduces the magnitude
    forward: function(ctx) { adjustAccountBalance(ctx.target_account, +ctx.amount); },
    inverse: function(ctx) { adjustAccountBalance(ctx.target_account, -ctx.amount); },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Workflow definitions — workflow_type → ordered step names
// ─────────────────────────────────────────────────────────────────────────────
const WORKFLOW_DEFS = {
  'account-credit': ['add-target'],
  'account-debit':  ['deduct-source'],
  'funds-transfer': ['deduct-source', 'add-target'],
  'forex-transfer': ['deduct-source', 'add-target'],
  'debt-repayment': ['deduct-source', 'reduce-liability'],
};

const VALID_WORKFLOW_TYPES = Object.keys(WORKFLOW_DEFS);

// ─────────────────────────────────────────────────────────────────────────────
// Execute — run forward steps in order
// ─────────────────────────────────────────────────────────────────────────────
function executeWorkflow(workflowType, ctx) {
  if (!workflowType)            return { ok: false, error: 'missing_workflow_type' };
  const steps = WORKFLOW_DEFS[workflowType];
  if (!steps)                   return { ok: false, error: 'unknown_workflow_type' };
  for (let i = 0; i < steps.length; i++) {
    WORKFLOW_STEPS[steps[i]].forward(ctx);
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reverse — run inverse steps in reverse order (used by update Phase 1 + delete)
// ─────────────────────────────────────────────────────────────────────────────
function reverseWorkflow(workflowType, ctx) {
  if (!workflowType)            return { ok: false, error: 'missing_workflow_type' };
  const steps = WORKFLOW_DEFS[workflowType];
  if (!steps)                   return { ok: false, error: 'unknown_workflow_type' };
  for (let i = steps.length - 1; i >= 0; i--) {
    WORKFLOW_STEPS[steps[i]].inverse(ctx);
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve — validate that a workflow_type string is known
// Returns the type string on success; { ok: false, error } on failure.
// Sheet lookup is the caller's responsibility (_findCategoryHints).
// ─────────────────────────────────────────────────────────────────────────────
function resolveWorkflow(workflowType) {
  if (!workflowType)            return { ok: false, error: 'missing_workflow_type' };
  if (!WORKFLOW_DEFS[workflowType]) return { ok: false, error: 'unknown_workflow_type' };
  return workflowType;
}
