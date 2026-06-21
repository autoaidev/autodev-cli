import { Task } from './todo';
import { buildMessage } from './messageBuilder';

// ---------------------------------------------------------------------------
// PromptBuilder — delegates to messageBuilder which writes split files
// ---------------------------------------------------------------------------

/**
 * Build the prompt string for a task, and write the split files:
 *   .autodev/AGENT_PROFILE.md                  — profile instructions (rebuilt fresh)
 *   .autodev/messages/MESSAGE_<timestamp>.md    — task trigger message
 *
 * The agent profile is loaded automatically by the agent via AGENTS.md → @.autodev/AGENT_PROFILE.md.
 */
export function buildPrompt(
  task: Task,
  root: string,
  todoDir: string,
  includeProfile = true,
): { prompt: string; messageFile: string } {
  return buildMessage(task, root, todoDir, includeProfile);
}
