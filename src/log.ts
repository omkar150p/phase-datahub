export type Log = (
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
) => void;

export const logJson: Log = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  (level === "info" ? process.stdout : process.stderr).write(line + "\n");
};

export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  return { name: error.name, message: error.message, code: "code" in error ? error.code : undefined };
}
