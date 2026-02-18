# Architecture Notes - Phase 1 Implementation

## Overview

This document outlines the architectural analysis and Phase 1 implementation of the Intent-Code Traceability Hook System for Roo Code.

## Roo Code Architecture Analysis

### Core Components

- **Extension Entry Point**: `src/extension.ts` - Initializes services and webview
- **Core Provider**: `src/core/webview/ClineProvider.ts` - Orchestrates AI conversations
- **Task System**: `src/core/task/Task.ts` - Manages individual AI conversation sessions
- **Tool System**: Dual-layer architecture
    - **Tool Definitions**: `src/core/prompts/tools/native-tools/` - OpenAI-compatible schemas
    - **Tool Implementations**: `src/core/tools/` - Classes extending `BaseTool`
- **System Prompts**: Built in `src/core/prompts/system.ts` with modular sections

### Tool Execution Flow

1. AI receives tool definitions in system prompt
2. AI calls tools via structured JSON requests
3. `ClineProvider` routes calls to appropriate tool classes via `presentAssistantMessage()`
4. Tools execute with validation, approval, and error handling
5. Results returned to AI conversation

### Key Integration Points

- **Tool Registration**: Tools added to `getNativeTools()` in `src/core/prompts/tools/native-tools/index.ts`
- **Tool Execution**: Handled in `presentAssistantMessage()` switch statement
- **System Prompts**: Modified via sections in `src/core/prompts/sections/`

## Phase 1 Implementation: The Handshake (Reasoning Loop)

### 1. Data Model (.orchestration/)

Created sidecar directory structure for machine-managed intent data:

- `active_intents.yaml` - Formal intent specifications with scope/constraints
- `agent_trace.jsonl` - Append-only ledger linking intents to code changes
- `intent_map.md` - Spatial mapping of intents to files/AST nodes
- `AGENT.md` - Shared knowledge base for cross-session learning

### 2. select_active_intent Tool

**Tool Definition**: `src/core/prompts/tools/native-tools/select_active_intent.ts`

- OpenAI-compatible function schema
- Takes `intent_id` parameter
- Forces agent to declare intent before code changes

**Tool Implementation**: `src/core/tools/SelectActiveIntentTool.ts`

- Extends `BaseTool<"select_active_intent">`
- Loads intent context from `.orchestration/active_intents.yaml`
- Returns XML-formatted context block with constraints and scope

**Type System Updates**:

- Added `"select_active_intent"` to `toolNames` in `packages/types/src/tool.ts`
- Added `select_active_intent: { intent_id: string }` to `NativeToolArgs`
- Added display name to `TOOL_DISPLAY_NAMES`

### 3. System Prompt Enforcement

Modified `getToolUseGuidelinesSection()` in `src/core/prompts/sections/tool-use-guidelines.ts`:

- Added "Intent-Driven Development Protocol" section
- Forces agent to call `select_active_intent` as first action
- Enforces scope boundaries and context injection

### 4. Hook System Infrastructure

**Hook Types**: `src/hooks/types.ts`

- `PreToolHook` - Executed before tool calls
- `PostToolHook` - Executed after tool calls
- Clean interface for middleware pattern

**Hook Engine**: `src/hooks/HookEngine.ts`

- Manages hook registration and execution
- Executes pre/post hooks around tool calls
- Handles hook failures gracefully

**Context Injector Hook**: `src/hooks/ContextInjectorHook.ts`

- Intercepts `select_active_intent` calls
- Loads intent context from YAML files
- Injects deep context into conversation
- Stores active intent in task state

### 5. Integration Points

**Tool Registration**: Added `select_active_intent` to tool exports
**Execution Integration**: Modified `presentAssistantMessage()` to:

- Initialize hook engine with context injector
- Wrap tool execution with `executeToolWithHooks()`
- Inject context from pre-hooks into conversation

## Key Architectural Decisions

### Middleware Pattern

- Hooks provide clean separation between core functionality and governance
- Pre/post phases allow interception without modifying tool implementations
- Fail-safe design prevents hook failures from breaking tool execution

### Context Injection Strategy

- XML-formatted context blocks for structured information
- Includes intent specification, constraints, scope, and history
- Injected as text messages to maintain conversation flow

### Type Safety

- Full TypeScript integration with existing Roo Code types
- Proper generic constraints for tool-specific typing
- Compile-time verification of hook interfaces

## Phase 1 Deliverables

- ✅ select_active_intent tool with full type safety
- ✅ .orchestration/ data model with sample data
- ✅ Hook system infrastructure (engine + context injector)
- ✅ System prompt enforcement of reasoning loop
- ✅ Integration with existing tool execution flow
- ✅ TypeScript compilation without errors

## Next Steps (Phase 2)

- Command classification (safe vs destructive)
- UI-blocking authorization for destructive operations
- Scope enforcement in pre-hooks
- .intentignore file support

## Testing Strategy

Phase 1 can be tested by:

1. Starting Roo Code with the modified extension
2. Attempting a code change request
3. Verifying that `select_active_intent` is called first
4. Confirming context injection from YAML files
5. Checking that scope constraints are loaded

This implementation establishes the foundation for intent-driven development while maintaining backward compatibility with existing Roo Code functionality.
