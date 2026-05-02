import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from '@cil/protocol';
import { hash } from '../hash.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);
const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

export interface ParseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const KIND_MAP: Record<string, NodeKind | undefined> = {
  function_declaration: 'function',
  function_expression: 'function',
  arrow_function: 'function',
  generator_function_declaration: 'function',
  method_definition: 'method',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'type',
};

const fileNodeId = (filePath: string): string => `file:${filePath}`;

const symbolId = (
  kind: NodeKind,
  filePath: string,
  name: string,
  line: number,
): string => `${kind}:${filePath}:${name}@${line}`;

const edgeId = (src: string, kind: EdgeKind, dst: string): string =>
  hash(`${src}|${kind}|${dst}`);

const stripQuotes = (s: string): string => s.replace(/^['"`]|['"`]$/g, '');

const firstLineSignature = (text: string): string | undefined => {
  const line = text.split('\n', 1)[0]?.trim();
  if (!line) return undefined;
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
};

const getName = (node: Parser.SyntaxNode): string | undefined => {
  const named = node.childForFieldName('name');
  return named?.text;
};

export const parseFile = (filePath: string, source: string): ParseResult => {
  const isTsx = filePath.endsWith('.tsx');
  const parser = isTsx ? tsxParser : tsParser;
  const tree = parser.parse(source);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileId = fileNodeId(filePath);

  nodes.push({
    id: fileId,
    kind: 'file',
    name: filePath,
    filePath,
    startLine: 0,
    endLine: tree.rootNode.endPosition.row,
    contentHash: hash(source),
  });

  const visit = (node: Parser.SyntaxNode): void => {
    // Symbols
    const kind = KIND_MAP[node.type];
    if (kind) {
      const name = getName(node) ?? '<anonymous>';
      const line = node.startPosition.row;
      const id = symbolId(kind, filePath, name, line);
      const text = source.slice(node.startIndex, node.endIndex);
      nodes.push({
        id,
        kind,
        name,
        filePath,
        startLine: line,
        endLine: node.endPosition.row,
        signature: firstLineSignature(text),
        contentHash: hash(text),
      });
      edges.push({
        id: edgeId(fileId, 'contains', id),
        src: fileId,
        dst: id,
        kind: 'contains',
      });
    }

    // Imports — phase 0 records the raw source string as the dst.
    // Resolution to a concrete file node happens in phase 1.
    if (node.type === 'import_statement') {
      const sourceField = node.childForFieldName('source');
      if (sourceField) {
        const importPath = stripQuotes(sourceField.text);
        const dst = `import:${importPath}`;
        edges.push({
          id: edgeId(fileId, 'imports', dst),
          src: fileId,
          dst,
          kind: 'imports',
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  };

  visit(tree.rootNode);
  return { nodes, edges };
};
