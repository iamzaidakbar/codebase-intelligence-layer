import pino from 'pino';

// stdout is reserved for JSON-RPC framing; logs MUST go to stderr.
export const log = pino(
  { level: process.env.CIL_LOG_LEVEL ?? 'info' },
  pino.destination(2),
);
