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
  generator_function_declaration: 'function',
  method_definition: 'method',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'type',
};

const fileNodeId = (filePath: string): string => `file:${filePath}`;

export const symbolId = (
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

const getName = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text;

/** Detect `const foo = () => {}` / `const foo = function() {}` and similar
 *  binding patterns so the function gets a real name. */
const variableBoundCallable = (
  declarator: Parser.SyntaxNode,
): { name: string; valueNode: Parser.SyntaxNode } | undefined => {
  const nameNode = declarator.childForFieldName('name');
  const valueNode = declarator.childForFieldName('value');
  if (!nameNode || !valueNode) return undefined;
  if (nameNode.type !== 'identifier') return undefined;
  if (
    valueNode.type !== 'arrow_function' &&
    valueNode.type !== 'function_expression'
  ) {
    return undefined;
  }
  return { name: nameNode.text, valueNode };
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

  const emitSymbol = (
    kind: NodeKind,
    name: string,
    bodyNode: Parser.SyntaxNode,
    anchorLine: number,
  ): void => {
    const id = symbolId(kind, filePath, name, anchorLine);
    const text = source.slice(bodyNode.startIndex, bodyNode.endIndex);
    nodes.push({
      id,
      kind,
      name,
      filePath,
      startLine: anchorLine,
      endLine: bodyNode.endPosition.row,
      signature: firstLineSignature(text),
      contentHash: hash(text),
    });
    edges.push({
      id: edgeId(fileId, 'contains', id),
      src: fileId,
      dst: id,
      kind: 'contains',
    });
  };

  /** When true, the visitor skips the given node id (used to avoid double-emitting
   *  an arrow_function that's already been counted via its variable binding). */
  const skipNodes = new Set<number>();

  const visit = (node: Parser.SyntaxNode): void => {
    if (skipNodes.has(node.id)) {
      // Still recurse — there may be nested callables inside.
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) visit(child);
      }
      return;
    }

    // Variable-bound callable: `const foo = () => {...}`
    if (node.type === 'variable_declarator') {
      const bound = variableBoundCallable(node);
      if (bound) {
        emitSymbol('function', bound.name, node, node.startPosition.row);
        skipNodes.add(bound.valueNode.id);
      }
    }

    const kind = KIND_MAP[node.type];
    if (kind) {
      const name = getName(node) ?? '<anonymous>';
      emitSymbol(kind, name, node, node.startPosition.row);
    }

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
