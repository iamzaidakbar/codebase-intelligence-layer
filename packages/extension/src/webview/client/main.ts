import cytoscape from 'cytoscape';
import type { GraphResult } from '@cil/protocol';
import type { HostToWebview, WebviewToHost } from '../messages.js';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
};

const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('title')!;

const post = (msg: WebviewToHost): void => vscode.postMessage(msg);

let cy: cytoscape.Core | undefined;
let isDark = true;

const KIND_COLOR: Record<string, string> = {
  file: '#4f8cc9',
  class: '#e0a458',
  interface: '#9c8fd6',
  function: '#5fb37a',
  method: '#7eb37c',
  type: '#c97a8c',
  variable: '#888888',
};

const EDGE_COLOR: Record<string, string> = {
  contains: '#666666',
  imports: '#5b9bd5',
  calls: '#e07b39',
  extends: '#9c8fd6',
  implements: '#c97a8c',
};

const baseStyle = (): cytoscape.StylesheetJson => [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'background-color': 'data(color)',
      color: isDark ? '#dcdcdc' : '#222222',
      'font-size': '11px',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 4,
      width: 'mapData(degree, 0, 20, 18, 50)',
      height: 'mapData(degree, 0, 20, 18, 50)',
      'text-outline-color': isDark ? '#1e1e1e' : '#ffffff',
      'text-outline-width': 2,
    },
  },
  {
    selector: 'node.root',
    style: {
      'border-width': 2,
      'border-color': '#ffd866',
      'font-weight': 'bold',
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': 'data(color)',
      'target-arrow-color': 'data(color)',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': '8px',
      color: isDark ? '#888' : '#444',
      'text-rotation': 'autorotate',
      'text-background-color': isDark ? '#1e1e1e' : '#ffffff',
      'text-background-opacity': 0.7,
      'text-background-padding': '2px',
    },
  },
];

const buildElements = (
  result: GraphResult,
): cytoscape.ElementDefinition[] => {
  const all = [...(result.root ? [result.root] : []), ...result.nodes];
  const seen = new Set<string>();
  const elements: cytoscape.ElementDefinition[] = [];

  // count degree per node id for sizing
  const degree = new Map<string, number>();
  for (const e of result.edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  for (const n of all) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const isRoot = n.id === result.root?.id;
    elements.push({
      group: 'nodes',
      data: {
        id: n.id,
        label: n.kind === 'file' ? labelForFile(n.name) : n.name,
        color: KIND_COLOR[n.kind] ?? '#888',
        degree: degree.get(n.id) ?? 0,
        kind: n.kind,
      },
      classes: isRoot ? 'root' : '',
    });
  }

  for (const e of result.edges) {
    elements.push({
      group: 'edges',
      data: {
        id: e.id,
        source: e.src,
        target: e.dst,
        label: e.kind,
        color: EDGE_COLOR[e.kind] ?? '#888',
      },
    });
  }

  return elements;
};

const labelForFile = (path: string): string => {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
};

const render = (title: string, payload: GraphResult): void => {
  titleEl.textContent = title;

  const elements = buildElements(payload);
  if (!cy) {
    cy = cytoscape({
      container: document.getElementById('cy'),
      elements,
      style: baseStyle(),
      layout: { name: 'cose', animate: false, fit: true, padding: 30 },
      wheelSensitivity: 0.2,
    });
    cy.on('tap', 'node', (evt) => {
      const id = evt.target.data('id') as string;
      post({ type: 'open-node', nodeId: id });
    });
    cy.on('dbltap', 'node', (evt) => {
      const id = evt.target.data('id') as string;
      post({ type: 'expand-node', nodeId: id });
    });
  } else {
    cy.elements().remove();
    cy.add(elements);
    cy.layout({ name: 'cose', animate: false, fit: true, padding: 30 }).run();
  }
};

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  if (msg.type === 'render') {
    render(msg.title, msg.payload);
  } else if (msg.type === 'theme') {
    isDark = msg.isDark;
    cy?.style(baseStyle());
  }
});

post({ type: 'ready' });
