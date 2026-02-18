# Implementation Plan — AI-Native IDE & Intent-Code Traceability

This document captures the implementation plan created during our conversation for the TRP1 challenge (Phase 0–4). It is intended as a concise reference for development, testing, and submission deliverables.

## High-level Goal

Upgrade Roo Code into a governed AI-Native IDE by implementing a Deterministic Hook System that:

- Enforces context via `.orchestration/` sidecar files
- Traces AI actions to intents using an append-only ledger and content hashing
- Automates governance with pre- and post-hooks that validate and persist intent-aware artifacts

## Deliverables

- `.orchestration/` directory with `active_intents.yaml`, `agent_trace.jsonl`, `intent_map.md`, `AGENT.md`
- `select_active_intent` native tool and implementation
- Hook engine with Pre/Post hooks isolated from core logic
- Scope enforcement pre-hook that blocks destructive actions outside an intent's `owned_scope`
- Post-hook that writes trace entries (Phase 3)
- Optimistic locking and shared CLAUDE.md lesson recording (Phase 4)

## Phase-by-phase Plan

Phase 0 — Archaeological Dig (Done)

- Confirmed runtime entry points: `presentAssistantMessage()` handles native tool execution.
- Located system prompt builder in `src/core/prompts/system.ts` and native tool definitions in `src/core/prompts/tools/native-tools/`.
- Deliverable: `ARCHITECTURE_NOTES.md` (analysis and integration points).

Phase 1 — The Handshake (Implemented)
Goal: Force the agent to declare intent before acting.
Tasks:

- Add `select_active_intent` tool definition and implementation (`src/core/prompts/tools/native-tools/select_active_intent.ts`, `src/core/tools/SelectActiveIntentTool.ts`).
- Create `.orchestration/active_intents.yaml`, `agent_trace.jsonl`, `intent_map.md`, `AGENT.md` (sidecar data model).
- Modify system prompt (`getToolUseGuidelinesSection`) to require the first tool call be `select_active_intent` for any code-modifying request.
- Implement `ContextInjectorHook` (PreToolHook) to load intent data and return an `<intent_context>` XML block.
- Register the hook in `presentAssistantMessage()` and wire injected context into the conversation flow.

Phase 2 — Hook Middleware & Security Boundary (In progress)
Goal: Enforce scope and authorization before destructive tools run.
Tasks:

- Implement `HookEngine` with typed `PreToolHook`/`PostToolHook` (`src/hooks/HookEngine.ts`, `src/hooks/types.ts`).
- Add `ScopeEnforcementHook` to:
    - Require `select_active_intent` before destructive tools.
    - Validate target paths against `owned_scope` extracted from the selected intent (from the active intent YAML or injected context).
    - For scope violations, prompt the user (HITL) via `task.ask` and block if not approved.
    - Require explicit approval for `execute_command`.
- Register `ScopeEnforcementHook` in `presentAssistantMessage()` so it runs pre-tool.

Phase 3 — AI-Native Git Layer (Traceability)
Goal: Log precise mappings from intent → code AST (spatially independent) → agent action.
Tasks:

- Implement SHA-256 content hashing utilities for code blocks (spatial independence).
- Extend mutating tool post-hooks to append structured trace entries to `.orchestration/agent_trace.jsonl` following the schema (include `intent_id`, `content_hash`, ranges, contributor metadata, `vcs.revision_id`).
- Modify write/apply tools to require `intent_id` and `mutation_class` metadata in tool payloads (AST_REFACTOR vs INTENT_EVOLUTION).

Phase 4 — Parallel Orchestration (Master Thinker)
Goal: Support parallel agents with optimistic locking and shared knowledge.
Tasks:

- Implement optimistic locking: on tool start compute file content hash; before write compare current hash; if mismatch, block with `Stale File` error.
- Implement a `Lessons Learned` Post-Hook that appends to `AGENT.md` on verification failures.
- Demonstrate parallel Architect/Builder sessions updating `.orchestration/agent_trace.jsonl` safely.

## Implementation Sequence & Milestones

- Week 1 (Interim): Phase 1 complete + Hook scaffolding committed. `IMPLEMENTATION_PLAN.md` saved for reference.
- Week 2 (Final): Complete Phases 2–4, polish prompts, tests, and demo video.

## Testing & Demo Plan

- Unit/smoke tests for hooks and tool handlers.
- Manual Dev Host test: open extension, trigger `select_active_intent`, verify `<intent_context>` injection.
- Simulated parallel run: open two extension panels; Architect declares intent; Builder performs write; show `agent_trace.jsonl` update; attempt out-of-scope write and show pre-hook block.
- Video: 4–5 minute screen capture showing the guarded flow and real-time trace updates.

## Evaluation Mapping (How to score max points)

- Intent-AST Correlation: Phase 3 must reliably compute content hashes and link `intent_id` → `ranges` → `content_hash` in `agent_trace.jsonl`.
- Context Engineering: Phase 1+2 ensure the agent cannot act without loading curated context; hook architecture prevents drift.
- Hook Architecture: Hooks are isolated from core provider logic and registered through `HookEngine`.
- Orchestration: Phase 4 demonstrates parallelism, optimistic locking, and shared `AGENT.md` knowledge.

## Notes & Next Steps

- Add Post-Hook to persist injected context to `.orchestration/last_selected_intent.xml` for easier inspection (optional convenience feature).
- Continue with Phase 2 testing in the Dev Host: select intent, attempt in-scope and out-of-scope writes, and verify user prompts and blocking behavior.

---

Saved from conversation on 2026-02-18.
