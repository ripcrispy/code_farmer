export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m, e) => console.error(`${new Date().toISOString()} ERROR ${m}`, e instanceof Error ? `\n${e.stack ?? e.message}` : e ?? ""),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Logger that records lines (tests). Errors are still printed so they are never hidden. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m, e) => {
      lines.push(`ERROR ${m}`);
      console.error(m, e);
    },
  };
}
