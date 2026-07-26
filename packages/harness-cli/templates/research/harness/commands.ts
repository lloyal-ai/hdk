/**
 * UI → main.ts command boundary.
 *
 * The Ink component tree dispatches commands through the `useCommand`
 * hook; main.ts drains them from an Effection Signal and runs the
 * corresponding Operation (runPlanner, runResearch, saveConfig, ...).
 *
 * Keep the union small and explicit. No generic "send arbitrary event"
 * escape hatch — that's what makes the UI <-> harness boundary auditable.
 */

export type Command =
  | { type: 'submit_query'; query: string; mode: 'flat' | 'deep'; skipPlanner?: boolean }
  | { type: 'submit_clarification'; answer: string }
  | { type: 'accept_plan' }
  | { type: 'cancel_plan' }
  | { type: 'edit_plan'; query: string }
  | { type: 'change_mode'; mode: 'flat' | 'deep' }
  | { type: 'update_task_description'; index: number; description: string }
  | { type: 'add_task'; afterIndex: number }
  | { type: 'delete_task'; index: number }
  | { type: 'move_task'; from: number; to: number }
  | { type: 'set_app_config'; name: string; values: Record<string, unknown> }
  | { type: 'set_output_dir'; path: string }
  // Global run-effort setting (pure policy preset). Set in Settings → Effort;
  // persisted to harness.json and applied to every subsequent query.
  | { type: 'set_effort'; effort: 'low' | 'medium' | 'high' | 'ultra' }
  | { type: 'set_model_path'; path: string }
  | { type: 'set_reranker_path'; path: string }
  // GPU backend variant (persisted as model.gpu; main.ts restarts the boot so
  // ctx + reranker reload on the new backend). Values mirror lloyal.node's
  // GpuVariant; 'default' = the platform binary's built-in backend.
  | { type: 'set_gpu'; gpu: 'default' | 'cuda' | 'vulkan' }
  // Boot-time BACKEND_DL pack offer (uiPhase 'backend_pack_offer'). Accept
  // downloads + installs the pack for this and every future boot; decline
  // persists model.backendPack=false so the offer never re-fires.
  | { type: 'accept_backend_pack' }
  | { type: 'decline_backend_pack' }
  | { type: 'toggle_participation'; name: string }
  // Escape hatch: interrupt the in-flight run (planner / research / synth) and
  // return to the composer. Handled in main.ts's command loop by halting the
  // spawned run Task (Effection halt tears down the run scope + cancels any
  // parked tool fetch via cancellable-fetch's scope-signal) and sending
  // `ui:composer`. No-op when no run is active. Never kills the loop/process.
  | { type: 'stop' }
  // Graceful "Wrap up": drain the in-flight run to a fast best-effort answer
  // instead of aborting it. Handled in main.ts by sending the WindDown signal
  // (NOT halting) — the pool stops spawning, reaps active agents, lets in-flight
  // tools settle, and folds the cohort into a recovered answer + synth. No-op
  // when no run is active. Distinct from `stop` (abort → composer).
  | { type: 'wrap_up' }
  // Per-agent cancel: discard one LIVE flat-mode research agent (halt its tool +
  // prune its KV + terminal agent:failed(user_cancel)); siblings keep running. The
  // renderer only offers this on a live, non-recovering flat-mode card.
  | { type: 'cancel_agent'; agentId: number }
  | { type: 'quit' };
