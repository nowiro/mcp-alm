/**
 * Prompt registry — natywny MCP feature `prompts/list` + `prompts/get`.
 *
 * Eksponuje preconfigured prompts że Copilot Chat widzi gotowe slash-commands
 * (`/recent-issues`, `/sprint-summary`, …) zamiast użytkownika musieć je pisać.
 * Konwencja MCP — patrz [spec](https://modelcontextprotocol.io/specification).
 *
 * Tokens saved przez:
 *   - LLM nie musi wymyślać kształtu zapytania (e.g. JQL composition);
 *   - skomplikowane multi-step flows redukują się do jednej linii;
 *   - cached przez Copilot Chat — nie tracimy contextu na "powtórz prompt".
 *
 * @see src/shared/mcp-server.ts — startMcpServer registers handlers
 */

/** Argument deklarowany w prompcie — Copilot pyta użytkownika gdy required. */
export interface PromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

/** Wiadomość w prompt — `user` lub `assistant`, content text-only (najprostsze). */
export interface PromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: {
    readonly type: 'text';
    readonly text: string;
  };
}

/**
 * Definicja promptu serwera. `buildMessages` jest pure funkcją —
 * given args, produkuje deterministic listę wiadomości.
 *
 * Backward compatible: server bez `prompts` w StartOptions działa
 * jak wcześniej (capabilities bez `prompts`).
 */
export interface PromptDefinition {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly PromptArgument[];
  readonly buildMessages: (args: Record<string, string>) => readonly PromptMessage[];
}

/** Constructor helper preserving readonly contracts. */
export function definePrompt(p: PromptDefinition): PromptDefinition {
  return p;
}
