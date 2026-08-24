import { parse } from "acorn";
import type { WorkerModuleInspector } from "./engine.ts";

const HANDLERS = ["fetch", "scheduled", "queue"] as const;
const JAVASCRIPT_MODULE = "application/javascript+module";

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Statically proves which portable handlers a JavaScript module exports.
 *
 * The source is parsed, never evaluated. A default export must be an object
 * literal, a top-level variable initialized to one, or a zero-argument call to
 * a top-level synchronous factory whose only statement returns one. Every
 * other call, spread and computed key stays closed because inspecting it would
 * execute tenant code or guess what it returns. Cloudflare still performs its
 * own full module validation when the exact bytes are uploaded.
 */
export function createJavaScriptWorkerModuleInspector(): WorkerModuleInspector {
  return {
    async inspect(input) {
      if (input.mediaType !== JAVASCRIPT_MODULE) return refused();
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input.bytes);
      } catch {
        return refused();
      }

      let program: { readonly body: readonly AstNode[] };
      try {
        program = parse(source, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowAwaitOutsideFunction: false,
        }) as unknown as { readonly body: readonly AstNode[] };
      } catch {
        return refused();
      }

      const declarations = new Map<string, AstNode>();
      const factories = new Map<string, AstNode>();
      const exportedClasses = new Set<string>();
      let exported: AstNode | undefined;
      for (const statement of program.body) {
        if (statement.type === "VariableDeclaration") {
          for (const declaration of nodes(statement.declarations)) {
            const name = identifierName(declaration.id);
            const initial = node(declaration.init);
            if (name && initial) declarations.set(name, initial);
          }
        }
        if (statement.type === "FunctionDeclaration") {
          const name = identifierName(statement.id);
          if (name) factories.set(name, statement);
        }
        if (statement.type === "ExportDefaultDeclaration") {
          if (exported) return refused();
          exported = node(statement.declaration);
        }
        if (statement.type === "ExportNamedDeclaration") {
          const declaration = node(statement.declaration);
          if (declaration?.type === "ClassDeclaration") {
            const name = identifierName(declaration.id);
            if (name) exportedClasses.add(name);
          }
          for (const specifier of nodes(statement.specifiers)) {
            if (identifierName(specifier.exported) === "default") {
              if (exported) return refused();
              const local = identifierName(specifier.local);
              if (local) exported = { type: "Identifier", name: local };
            }
          }
        }
      }

      const object = resolveObject(exported, declarations, factories, new Set());
      if (!object) return refused();
      const found = new Set<string>();
      for (const property of nodes(object.properties)) {
        if (property.type === "SpreadElement" || property.computed === true) return refused();
        if (property.type !== "Property" || property.kind !== "init") continue;
        const name = propertyName(property.key);
        if (!name || !HANDLERS.includes(name as (typeof HANDLERS)[number])) continue;
        const value = node(property.value);
        if (!value || !isFunction(value)) return refused();
        found.add(name);
      }
      return {
        loadable: true,
        handlers: HANDLERS.filter((handler) => found.has(handler)),
        ...(exportedClasses.size > 0 ? { classes: [...exportedClasses].sort() } : {}),
      };
    },
  };
}

function resolveObject(
  candidate: AstNode | undefined,
  declarations: ReadonlyMap<string, AstNode>,
  factories: ReadonlyMap<string, AstNode>,
  seen: Set<string>,
): AstNode | null {
  if (!candidate) return null;
  if (candidate.type === "ObjectExpression") return candidate;
  if (candidate.type === "CallExpression") {
    const argumentsValue = candidate.arguments;
    if (!Array.isArray(argumentsValue) || argumentsValue.length !== 0) return null;
    const name = identifierName(candidate.callee);
    if (!name || seen.has(name)) return null;
    const factory = factories.get(name);
    if (!factory || factory.async === true || factory.generator === true) return null;
    const body = node(factory.body);
    const statements = body ? nodes(body.body) : [];
    if (statements.length !== 1 || statements[0]?.type !== "ReturnStatement") return null;
    seen.add(name);
    return resolveObject(node(statements[0].argument), declarations, factories, seen);
  }
  if (candidate.type !== "Identifier") return null;
  const name = identifierName(candidate);
  if (!name || seen.has(name)) return null;
  seen.add(name);
  return resolveObject(declarations.get(name), declarations, factories, seen);
}

function isFunction(value: AstNode): boolean {
  return (
    value.type === "FunctionExpression" ||
    value.type === "ArrowFunctionExpression" ||
    value.type === "FunctionDeclaration"
  );
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

function refused() {
  return { loadable: false, handlers: [] } as const;
}
