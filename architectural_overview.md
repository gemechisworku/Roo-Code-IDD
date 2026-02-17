# Architectural Overview of Roo Code

Roo Code is an AI-powered coding assistant VS Code extension that provides intelligent code generation, refactoring, debugging, and automation capabilities directly within the editor. It's built as a sophisticated monorepo using modern development practices.

## Overall Architecture

**Project Structure:**

- **Monorepo**: Uses pnpm workspaces and Turbo for build orchestration
- **Main Components**:
    - `src/`: Core VS Code extension code
    - `webview-ui/`: React-based webview interface
    - `apps/cli/`: Standalone CLI version
    - `packages/`: Shared libraries and services
    - `locales/`: Internationalization support

**Core Architecture Pattern:**

- **Event-driven**: Uses VS Code's webview messaging system
- **Provider-based**: Implements `vscode.WebviewViewProvider` for the sidebar interface
- **Tool-based**: AI interactions through structured tool calls (similar to OpenAI function calling)
- **State management**: Context proxy for settings and state isolation

## Key Architectural Components

1. **Extension Entry Point** (`src/extension.ts`):

    - Initializes services (telemetry, MDM, MCP, code indexing)
    - Sets up the main `ClineProvider` for webview management
    - Handles authentication and cloud services

2. **Core Provider** (`src/core/webview/ClineProvider.ts`):

    - Main orchestrator for AI conversations and tool execution
    - Manages task lifecycle, webview communication, and state
    - Implements the VS Code webview provider interface

3. **Task System** (`src/core/task/`):
    - Manages individual AI conversation sessions
    - Handles tool execution, approval workflows, and result processing
    - Maintains conversation history and state

## Tool System Architecture

Tools are implemented in a dual-layer architecture:

### 1. Tool Definitions for AI Prompts

**Location**: `src/core/prompts/tools/native-tools/`

- **execute_command.ts**: Defines the tool schema for command execution
- **write_to_file.ts**: Defines the tool schema for file writing
- These are OpenAI-compatible tool definitions used in system prompts

### 2. Tool Implementation Classes

**Location**: `src/core/tools/`

- **ExecuteCommandTool.ts**: Actual implementation of command execution logic
- **WriteToFileTool.ts**: Actual implementation of file writing logic
- These classes handle validation, execution, error handling, and result formatting

**Tool Execution Flow**:

1. AI receives tool definitions in system prompt
2. AI calls tools via structured JSON requests
3. `ClineProvider` routes calls to appropriate tool classes
4. Tools execute with proper validation and error handling
5. Results are formatted and returned to the AI

## System Prompt Construction

The system prompt is dynamically constructed through a modular, layered approach in `src/core/prompts/system.ts`. The prompt building process follows a specific order to create a comprehensive context for the AI:

### Prompt Assembly Order

1. **Role Definition** (`roleDefinition` from mode config):

    - Defines the AI's persona and behavioral guidelines based on the selected mode (Code, Architect, Ask, Debug, etc.)
    - Retrieved from mode configuration with fallback to built-in modes

2. **Markdown Formatting Rules** (`markdownFormattingSection()`):

    - Establishes strict formatting requirements for all responses
    - Requires clickable links for code constructs and file references
    - Enforces consistent markdown structure across all interactions

3. **Tool Use Instructions** (`getSharedToolUseSection()`):

    - Defines the tool-calling mechanism and approval workflow
    - Requires at least one tool call per assistant response
    - Encourages batching multiple tool calls to reduce conversation overhead

4. **Tool Use Guidelines** (`getToolUseGuidelinesSection()`):

    - Provides detailed instructions for proper tool usage
    - Includes parameter validation and error handling guidance

5. **Capabilities Section** (`getCapabilitiesSection()`):

    - Describes available tools and their purposes
    - Includes workspace context and file system access information
    - Conditionally adds MCP server capabilities if available

6. **Modes Section** (`getModesSection()` - async):

    - Dynamically generated list of all available modes
    - Includes mode descriptions and when-to-use guidelines
    - Retrieved from extension state and custom mode configurations

7. **Skills Section** (`getSkillsSection()` - conditional):

    - Adds custom skill definitions if skills manager is available
    - Provides specialized capabilities beyond built-in tools

8. **Rules Section** (`getRulesSection()`):

    - Defines operational constraints and safety guidelines
    - Includes workspace-specific rules and restrictions

9. **System Information** (`getSystemInfoSection()`):

    - Provides current working directory and system context
    - Includes environment details for tool execution

10. **Objective Section** (`getObjectiveSection()`):

    - Defines the iterative problem-solving approach
    - Establishes goal-setting and task completion workflow
    - Requires use of `attempt_completion` tool for final results

11. **Custom Instructions** (`addCustomInstructions()` - async):
    - Processes mode-specific and global custom instructions
    - Handles language-specific formatting and roo-ignore rules
    - Applied last to override any conflicting base instructions

### Construction Process Details

- **Asynchronous Components**: Modes and skills sections are loaded asynchronously for performance
- **Conditional Inclusion**: MCP capabilities and skills are only included when available
- **Context Awareness**: Many sections incorporate runtime context (cwd, settings, language)
- **Modular Design**: Each section is independently maintainable and testable
- **Extensibility**: New sections can be added without modifying the core assembly logic

The final prompt is assembled as a single string with section separators (`====`) for clear delineation, creating a comprehensive context that enables the AI to understand its capabilities, constraints, and operational environment.

## Additional Architectural Notes

- **MCP Integration**: Model Context Protocol for extending capabilities
- **Skills System**: Custom skill definitions and execution
- **Code Indexing**: Background indexing for codebase understanding
- **Multi-modal**: Supports different AI modes (Code, Architect, Ask, Debug)
- **Cloud Services**: Authentication, remote control, and cloud storage
- **Internationalization**: Full i18n support with locale files

The architecture emphasizes modularity, extensibility, and robust error handling, allowing for complex AI-assisted development workflows while maintaining VS Code integration best practices.</content>
<parameter name="filePath">d:\FDE Training\Roo-Code-IDD\architectural_overview.md
