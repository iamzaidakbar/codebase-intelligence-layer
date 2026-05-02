import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import { log } from '../log.js';

export const startStdioRpc = (): MessageConnection => {
  const conn = createMessageConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );
  conn.onError(([err]) => log.error({ err: err.message }, 'rpc error'));
  conn.onClose(() => {
    log.info('rpc connection closed');
    process.exit(0);
  });
  return conn;
};
