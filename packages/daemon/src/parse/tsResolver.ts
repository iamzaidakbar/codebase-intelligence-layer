import { join, relative, sep } from 'node:path';
import {
  ModuleKind,
  ModuleResolutionKind,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
} from 'ts-morph';
import { log } from '../log.js';

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

/** Location of a symbol in source. The indexer maps these to node IDs by
 *  matching against tree-sitter-produced rows in the store. */
export interface RawLocation {
  filePath: string;
  /** 0-indexed start line. */
  line: number;
  name: string;
  kind: 'file' | 'function' | 'method' | 'class' | 'interface';
}

export type RawEdgeKind = 'calls' | 'imports' | 'extends' | 'implements';

export interface RawEdge {
  kind: RawEdgeKind;
  src: RawLocation;
  dst: RawLocation;
}

const fileLocation = (rel: string): RawLocation => ({
  filePath: rel,
  line: 0,
  name: rel,
  kind: 'file',
});

const callableContainerKind = (n: Node): RawLocation['kind'] => {
  if (
    Node.isMethodDeclaration(n) ||
    Node.isConstructorDeclaration(n) ||
    Node.isGetAccessorDeclaration(n) ||
    Node.isSetAccessorDeclaration(n)
  ) {
    return 'method';
  }
  return 'function';
};

const callableContainerName = (n: Node): string | undefined => {
  if (Node.isFunctionDeclaration(n)) return n.getName();
  if (Node.isMethodDeclaration(n)) return n.getName();
  if (Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n)) {
    return n.getName();
  }
  if (Node.isConstructorDeclaration(n)) return 'constructor';
  if (Node.isFunctionExpression(n)) {
    const own = n.getName();
    if (own) return own;
  }
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) {
    const parent = n.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }
    if (parent && Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }
  }
  return undefined;
};

const findContainer = (node: Node, fileRel: string): RawLocation => {
  const ancestor = node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isMethodDeclaration(a) ||
      Node.isConstructorDeclaration(a) ||
      Node.isGetAccessorDeclaration(a) ||
      Node.isSetAccessorDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a),
  );
  if (!ancestor) return fileLocation(fileRel);
  const name = callableContainerName(ancestor) ?? '<anonymous>';
  return {
    filePath: fileRel,
    line: ancestor.getStartLineNumber() - 1,
    name,
    kind: callableContainerKind(ancestor),
  };
};

const declarationLocation = (
  decl: Node,
  fileRel: string,
): RawLocation | undefined => {
  let name: string | undefined;
  let kind: RawLocation['kind'] | undefined;

  if (Node.isFunctionDeclaration(decl)) {
    name = decl.getName();
    kind = 'function';
  } else if (Node.isMethodDeclaration(decl)) {
    name = decl.getName();
    kind = 'method';
  } else if (Node.isConstructorDeclaration(decl)) {
    name = 'constructor';
    kind = 'method';
  } else if (Node.isClassDeclaration(decl)) {
    name = decl.getName();
    kind = 'class';
  } else if (Node.isInterfaceDeclaration(decl)) {
    name = decl.getName();
    kind = 'interface';
  } else if (Node.isVariableDeclaration(decl)) {
    name = decl.getName();
    kind = 'function';
  } else {
    return undefined;
  }
  if (!name) return undefined;
  return {
    filePath: fileRel,
    line: decl.getStartLineNumber() - 1,
    name,
    kind,
  };
};

export class TsResolver {
  private project: Project;

  constructor(private root: string) {
    this.project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        jsx: 4, // Preserve
        target: ScriptTarget.ESNext,
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    });
  }

  /** Bulk-add files. Returns count actually added. */
  addFiles(absPaths: string[]): number {
    let added = 0;
    for (const p of absPaths) {
      if (this.project.getSourceFile(p)) continue;
      const sf = this.project.addSourceFileAtPathIfExists(p);
      if (sf) added++;
    }
    return added;
  }

  refreshFile(absPath: string): void {
    const sf = this.project.getSourceFile(absPath);
    if (sf) {
      try {
        sf.refreshFromFileSystemSync();
      } catch (err) {
        log.warn({ err, absPath }, 'ts-morph refresh failed');
      }
    } else {
      this.project.addSourceFileAtPathIfExists(absPath);
    }
  }

  removeFile(absPath: string): void {
    const sf = this.project.getSourceFile(absPath);
    if (sf) this.project.removeSourceFile(sf);
  }

  /** Walk a single file's AST and produce semantic edges (imports, calls). */
  extractEdges(absPath: string): RawEdge[] {
    const sf = this.project.getSourceFile(absPath);
    if (!sf) return [];

    const fileRel = toPosix(relative(this.root, absPath));
    const edges: RawEdge[] = [];

    this.collectImports(sf, fileRel, edges);
    this.collectCalls(sf, fileRel, edges);
    this.collectInheritance(sf, fileRel, edges);

    return edges;
  }

  private collectImports(
    sf: SourceFile,
    fileRel: string,
    out: RawEdge[],
  ): void {
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue;
      if (target.isInNodeModules()) continue;
      const tgtRel = toPosix(relative(this.root, target.getFilePath()));
      out.push({
        kind: 'imports',
        src: fileLocation(fileRel),
        dst: fileLocation(tgtRel),
      });
    }
  }

  private collectCalls(
    sf: SourceFile,
    fileRel: string,
    out: RawEdge[],
  ): void {
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return;

      const expr = node.getExpression();
      let symbol = expr.getSymbol();
      if (!symbol) return;
      const aliased = symbol.getAliasedSymbol();
      if (aliased) symbol = aliased;

      const decls = symbol.getDeclarations();
      if (decls.length === 0) return;

      const container = findContainer(node, fileRel);
      const seen = new Set<string>();

      for (const decl of decls) {
        const declSf = decl.getSourceFile();
        if (declSf.isInNodeModules()) continue;
        const dstRel = toPosix(relative(this.root, declSf.getFilePath()));
        const dst = declarationLocation(decl, dstRel);
        if (!dst) continue;
        const key = `${dst.kind}:${dst.filePath}:${dst.name}@${dst.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: 'calls', src: container, dst });
      }
    });
  }

  private collectInheritance(
    sf: SourceFile,
    fileRel: string,
    out: RawEdge[],
  ): void {
    for (const cls of sf.getClasses()) {
      const className = cls.getName();
      if (!className) continue;
      const srcLoc: RawLocation = {
        filePath: fileRel,
        line: cls.getStartLineNumber() - 1,
        name: className,
        kind: 'class',
      };

      const ext = cls.getExtends();
      if (ext) {
        const symbol = ext.getExpression().getSymbol();
        if (symbol) {
          const decls = (symbol.getAliasedSymbol() ?? symbol).getDeclarations();
          for (const decl of decls) {
            const declSf = decl.getSourceFile();
            if (declSf.isInNodeModules()) continue;
            const dstRel = toPosix(relative(this.root, declSf.getFilePath()));
            const dst = declarationLocation(decl, dstRel);
            if (dst) out.push({ kind: 'extends', src: srcLoc, dst });
          }
        }
      }

      for (const impl of cls.getImplements()) {
        const symbol = impl.getExpression().getSymbol();
        if (!symbol) continue;
        const decls = (symbol.getAliasedSymbol() ?? symbol).getDeclarations();
        for (const decl of decls) {
          const declSf = decl.getSourceFile();
          if (declSf.isInNodeModules()) continue;
          const dstRel = toPosix(relative(this.root, declSf.getFilePath()));
          const dst = declarationLocation(decl, dstRel);
          if (dst) out.push({ kind: 'implements', src: srcLoc, dst });
        }
      }
    }
  }
}

export const absolutize = (root: string, rel: string): string => join(root, rel);
