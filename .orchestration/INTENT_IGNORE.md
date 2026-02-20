Intent ignore file (.intentignore)

- Location: `.orchestration/.intentignore`
- Purpose: list intent IDs (one per line) to exclude from scope enforcement.
- Format: plain text, lines starting with `#` are comments. Example:

# Skip enforcement for migration intents

INT-001
INT-007

- Matching: exact ID match (no globs). If you need glob-like behavior, list the intent IDs explicitly.

Scope enforcement will skip intents listed in this file, allowing tools to run without active intent checks for those intents.
