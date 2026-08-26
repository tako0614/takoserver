import { parse } from "acorn";
import type { WorkerModuleInspector } from "./engine.ts";
import { TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES } from "./limits.ts";

const HANDLERS = ["fetch", "scheduled", "queue"] as const;
const JAVASCRIPT_MODULE = "application/javascript+module";
const MAX_AST_DEPTH = 128;
const MAX_AST_NODES = 1_000_000;
const MAX_PARSE_TOKENS = 4_000_000;
const MAX_INSPECTION_MILLISECONDS = 5_000;

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface DirectObjectDeclaration {
  readonly object: AstNode;
  readonly statementIndex: number;
}

interface DefaultExport {
  readonly declaration: AstNode;
  readonly statement: AstNode;
  readonly statementIndex: number;
}

/**
 * Statically proves only the narrow Worker handler shape the host needs.
 *
 * The source is parsed, never evaluated. Each handler must be written directly
 * as a function, arrow, or object method on the default-exported object. A
 * top-level object declaration may be referenced exactly one statement later
 * by the module's final export (the shape emitted by esbuild), but aliases,
 * factories, member expressions, computed keys, getters, and spreads stay
 * closed. This deliberately avoids becoming a partial JavaScript effect
 * interpreter. Cloudflare still validates the exact uploaded module bytes.
 */
export function createJavaScriptWorkerModuleInspector(): WorkerModuleInspector {
  return {
    async inspect(input) {
      if (
        input.mediaType !== JAVASCRIPT_MODULE ||
        input.bytes.byteLength > TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES
      ) {
        return refused();
      }

      const deadline = performance.now() + MAX_INSPECTION_MILLISECONDS;
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input.bytes);
      } catch {
        return refused();
      }
      if (expired(deadline)) return refused();

      let program: AstNode;
      let tokenCount = 0;
      try {
        program = parse(source, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowAwaitOutsideFunction: false,
          onToken: () => {
            tokenCount += 1;
            if (tokenCount > MAX_PARSE_TOKENS || (tokenCount % 1_024 === 0 && expired(deadline))) {
              throw new Error("worker module inspection budget exceeded");
            }
          },
        }) as unknown as AstNode;
      } catch {
        return refused();
      }

      if (!astIsWithinBounds(program, deadline)) return refused();
      const body = nodes(program.body);
      const declarations = new Map<string, DirectObjectDeclaration>();
      const declarationCounts = new Map<string, number>();
      const exportedClasses = new Set<string>();
      let defaultExport: DefaultExport | undefined;

      for (const [statementIndex, statement] of body.entries()) {
        if (expired(deadline)) return refused();
        recordTopLevelDeclaration(statement, statementIndex, declarations, declarationCounts);

        if (statement.type === "ExportDefaultDeclaration") {
          const declaration = node(statement.declaration);
          if (!declaration || defaultExport) return refused();
          defaultExport = { declaration, statement, statementIndex };
        }

        if (statement.type !== "ExportNamedDeclaration") continue;
        const declaration = node(statement.declaration);
        if (declaration) {
          recordTopLevelDeclaration(declaration, statementIndex, declarations, declarationCounts);
          if (declaration.type === "ClassDeclaration") {
            const name = identifierName(declaration.id);
            if (name) exportedClasses.add(name);
          }
        }
        for (const specifier of nodes(statement.specifiers)) {
          if (identifierName(specifier.exported) !== "default") continue;
          const local = identifierName(specifier.local);
          if (!local || defaultExport || statement.source != null) return refused();
          defaultExport = {
            declaration: { type: "Identifier", name: local },
            statement,
            statementIndex,
          };
        }
      }

      const exportedObject = resolveDirectExportObject(
        defaultExport,
        body,
        declarations,
        declarationCounts,
      );
      if (!exportedObject || expired(deadline)) return refused();

      const handlers = inspectDirectHandlers(exportedObject);
      if (!handlers) return refused();
      return {
        loadable: true,
        handlers,
        ...(exportedClasses.size > 0 ? { classes: [...exportedClasses].sort() } : {}),
      };
    },
  };
}

function recordTopLevelDeclaration(
  statement: AstNode,
  statementIndex: number,
  declarations: Map<string, DirectObjectDeclaration>,
  declarationCounts: Map<string, number>,
): void {
  if (statement.type === "VariableDeclaration") {
    const entries = nodes(statement.declarations);
    for (const declaration of entries) {
      const name = identifierName(declaration.id);
      if (name) countDeclaration(declarationCounts, name);
    }
    if (entries.length !== 1) return;
    const name = identifierName(entries[0]?.id);
    const initial = node(entries[0]?.init);
    if (name && initial?.type === "ObjectExpression" && !declarations.has(name)) {
      declarations.set(name, { object: initial, statementIndex });
    }
    return;
  }

  if (statement.type === "ClassDeclaration" || statement.type === "FunctionDeclaration") {
    const name = identifierName(statement.id);
    if (name) countDeclaration(declarationCounts, name);
  }
}

function resolveDirectExportObject(
  exported: DefaultExport | undefined,
  body: readonly AstNode[],
  declarations: ReadonlyMap<string, DirectObjectDeclaration>,
  declarationCounts: ReadonlyMap<string, number>,
): AstNode | null {
  if (!exported) return null;
  if (exported.declaration.type === "ObjectExpression") return exported.declaration;
  if (exported.declaration.type !== "Identifier") return null;

  const name = identifierName(exported.declaration);
  const declaration = name ? declarations.get(name) : undefined;
  if (
    !name ||
    !declaration ||
    declarationCounts.get(name) !== 1 ||
    exported.statementIndex !== body.length - 1 ||
    declaration.statementIndex !== exported.statementIndex - 1
  ) {
    return null;
  }

  if (exported.statement.type === "ExportNamedDeclaration") {
    const exportsOfObject = nodes(exported.statement.specifiers).filter(
      (specifier) => identifierName(specifier.local) === name,
    );
    if (
      exportsOfObject.length !== 1 ||
      identifierName(exportsOfObject[0]?.exported) !== "default"
    ) {
      return null;
    }
  }
  return declaration.object;
}

function inspectDirectHandlers(object: AstNode): readonly string[] | null {
  const found = new Set<string>();
  for (const property of nodes(object.properties)) {
    if (property.type !== "Property" || property.computed === true || property.kind !== "init") {
      return null;
    }
    const name = propertyName(property.key);
    if (!name || !HANDLERS.includes(name as (typeof HANDLERS)[number])) continue;
    if (found.has(name)) return null;
    const value = node(property.value);
    if (!value || !isDirectFunction(value)) return null;
    found.add(name);
  }
  return HANDLERS.filter((handler) => found.has(handler));
}

function astIsWithinBounds(root: AstNode, deadline: number): boolean {
  const pending: { readonly node: AstNode; readonly depth: number }[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > MAX_AST_DEPTH) return false;
    visited += 1;
    if (visited > MAX_AST_NODES || (visited % 1_024 === 0 && expired(deadline))) return false;
    for (const value of Object.values(current.node)) {
      const child = node(value);
      if (child) {
        pending.push({ node: child, depth: current.depth + 1 });
        continue;
      }
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const arrayChild = node(item);
        if (arrayChild) pending.push({ node: arrayChild, depth: current.depth + 1 });
      }
    }
  }
  return !expired(deadline);
}

function isDirectFunction(value: AstNode): boolean {
  return value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression";
}

function countDeclaration(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function propertyName(value: unknown): string | null {
  const candidate = node(value);
  if (!candidate) return null;
  if (candidate.type === "Identifier") return identifierName(candidate);
  if (candidate.type === "Literal" && typeof candidate.value === "string") {
    return candidate.value;
  }
  return null;
}

function identifierName(value: unknown): string | null {
  const candidate = node(value);
  return candidate?.type === "Identifier" && typeof candidate.name === "string"
    ? candidate.name
    : null;
}

function node(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string"
    ? (value as AstNode)
    : undefined;
}

function nodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => (node(candidate) ? [candidate as AstNode] : []))
    : [];
}

function expired(deadline: number): boolean {
  return performance.now() > deadline;
}

function refused() {
  return { loadable: false, handlers: [] } as const;
}
