import type { GraphResult } from '@cil/protocol';

/** Messages sent from extension host -> webview. */
export type HostToWebview =
  | { type: 'render'; title: string; payload: GraphResult }
  | { type: 'theme'; isDark: boolean };

/** Messages sent from webview -> extension host. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'open-node'; nodeId: string }
  | { type: 'expand-node'; nodeId: string };
