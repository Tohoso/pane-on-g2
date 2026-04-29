export type ToolInput = Record<string, unknown> | undefined | null;

const MAX_ONELINER_CHARS = 60;

export function summarizeToolCall(name = "tool", input?: unknown): string {
  const tool = name || "tool";
  const fields = isRecord(input) ? input : {};
  const lower = tool.toLowerCase();

  if (lower === "bash") {
    const command = firstString(fields.command, fields.cmd, fields.description);
    return `${tool}: ${truncate(normalize(command || "command"))}`;
  }

  if (lower === "read") {
    return `${tool}: ${pathFrom(fields) || "file"}`;
  }

  if (lower === "edit" || lower === "multiedit") {
    return `${tool}: edit ${pathFrom(fields) || "file"}`;
  }

  if (lower === "write") {
    return `${tool}: write ${pathFrom(fields) || "file"}`;
  }

  if (lower === "grep" || lower === "glob" || lower === "rg") {
    const pattern = firstString(fields.pattern, fields.query, fields.glob) || "pattern";
    const path = pathFrom(fields);
    return `${tool}: ${truncate(normalize(path ? `${pattern} in ${path}` : pattern))}`;
  }

  const path = pathFrom(fields);
  if (path) return `${tool}: ${path}`;
  return tool;
}

function pathFrom(fields: Record<string, unknown>): string | undefined {
  return firstString(fields.file_path, fields.path, fields.notebook_path, fields.cwd);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_ONELINER_CHARS) return text;
  return `${chars.slice(0, MAX_ONELINER_CHARS - 1).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
