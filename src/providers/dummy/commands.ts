// ---------------------------------------------------------------------------
// Dummy command parser — maps a prompt to a small, deterministic action so
// unit tests can drive the dummy without a real model.
// ---------------------------------------------------------------------------

export type DummyCommandKind =
  | 'hello'
  | 'list'
  | 'read'
  | 'write'
  | 'bash'
  | 'todo'
  | 'complete'
  | 'lifecycle';

export interface DummyCommand {
  kind: DummyCommandKind;
  arg?: string;
  raw: string;
}

/** Pull the last user-looking paragraph out of a combined profile+message file. */
export function extractUserText(combined: string): string {
  const trimmed = combined.trim();
  const parts = trimmed.split(/\n---\n/);
  const first = (parts[0] ?? trimmed).trim();
  return first.slice(0, 4000);
}

export function parseDummyCommand(text: string): DummyCommand {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  if (/\b(hello|hi|hey)\b/.test(lower) && lower.length < 80) {
    return { kind: 'hello', raw };
  }
  if (/\b(bash|run|shell|terminal)\b/.test(lower)) {
    const cmd = raw.match(/(?:bash|run|shell)\s+`?([^`\n]+)`?/i);
    return { kind: 'bash', arg: cmd?.[1]?.trim() ?? 'ls -la', raw };
  }
  if (/\b(list files|list dir|ls\b|list_dir)\b/.test(lower)) {
    return { kind: 'list', raw };
  }
  const read = raw.match(/\bread(?:\s+file)?\s+([^\s]+)/i);
  if (read) { return { kind: 'read', arg: read[1], raw }; }
  const write = raw.match(/\b(?:write|create)\s+(?:file\s+)?([^\s]+)/i);
  if (write) { return { kind: 'write', arg: write[1], raw }; }
  if (/\b(build|implement|scaffold)\b/.test(lower)) {
    return { kind: 'lifecycle', raw };
  }
  if (/^(todo|task list|backlog)\b/.test(lower) || /\bupdate (the )?todo\b/.test(lower)) {
    return { kind: 'todo', raw };
  }
  if (/\b(complete|done|check off|mark done)\b/.test(lower)) {
    return { kind: 'complete', raw };
  }
  return { kind: 'lifecycle', raw };
}
