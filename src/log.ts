export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
export type Logger = (level: LogLevel, message: string, fields?: LogFields) => void;

/** JSON lines. Callers never pass tokens or credential content. */
export function jsonLogger(stream: NodeJS.WritableStream): Logger {
  return (level, message, fields = {}) => {
    stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields })}\n`);
  };
}
