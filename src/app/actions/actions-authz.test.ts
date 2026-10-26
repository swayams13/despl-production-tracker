import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * AUD-095: authz.test.ts proves the predicates (hasRole, assertClientScope…),
 * not that every entry point uses them. middleware.ts lets a Server Action POST
 * with a dead session through to the action (AUD-062), so each action must
 * itself reach `requireActor()` / `getActor()` and use the result: that call is
 * the session, tenant and must-change-password gate, and the actor it returns is
 * what the service layer checks roles and tenant scope with.
 *
 * Static, on purpose: it needs no DB and fails the moment someone adds an
 * export that forgets the gate. It cannot prove the service applies the right
 * role; the per-service authz tests do that.
 */

/** Actions that are public by design. Every entry needs a reason. */
const PUBLIC_ACTIONS: Record<string, string> = {
  "auth.ts#login": "pre-authentication: verifies the password itself and is throttled",
  "auth.ts#logout": "only deletes the caller's own cookie",
};

const GATES = new Set(["requireActor", "getActor"]);

/** Exported functions in `source` that never call a gate, or call it and drop the result. */
function ungatedExports(source: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const bad: string[] = [];

  const check = (name: string, body: ts.Node) => {
    let gated = false;
    const actorNames = new Set<string>();
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && GATES.has(n.expression.text)) {
        // `const actor = await requireActor()` -> remember `actor`; passed inline -> used by construction.
        let p: ts.Node = n.parent;
        if (ts.isAwaitExpression(p)) p = p.parent;
        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) actorNames.add(p.name.text);
        else if (ts.isCallExpression(p) || ts.isThrowStatement(p.parent ?? p) || ts.isIfStatement(p) || ts.isPrefixUnaryExpression(p)) gated = true;
        else if (ts.isBinaryExpression(p) || ts.isExpressionStatement(p)) gated = true; // `x ?? await…`, bare `await requireActor()` (a session check)
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    if (!gated && actorNames.size > 0) {
      // Used somewhere other than its declaration.
      const uses = (n: ts.Node): boolean =>
        (ts.isIdentifier(n) && actorNames.has(n.text) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)) ||
        ts.forEachChild(n, uses) === true;
      gated = uses(body);
    }
    if (!gated) bad.push(name);
  };

  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.body && st.name) check(st.name.text, st.body);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isIdentifier(d.name)) {
          check(d.name.text, d.initializer.body);
        }
      }
    }
  }
  return bad;
}

describe("the checker itself (violation cases first)", () => {
  it("flags an action that never asks who the caller is", () => {
    expect(ungatedExports(`export async function wipe(id: number) { return svc.wipe(id); }`)).toEqual(["wipe"]);
  });

  it("flags an action that fetches the actor and then ignores it", () => {
    expect(ungatedExports(`export async function wipe(id: number) { const actor = await requireActor(); return svc.wipe(id); }`)).toEqual(["wipe"]);
  });

  it("flags an arrow-function export with no gate", () => {
    expect(ungatedExports(`export const wipe = async (id: number) => svc.wipe(id);`)).toEqual(["wipe"]);
  });

  it("flags only the offender among several exports", () => {
    const src = `
      export async function ok() { return svc.ok(await requireActor()); }
      export async function bad() { return svc.bad(); }`;
    expect(ungatedExports(src)).toEqual(["bad"]);
  });

  it("accepts the actor passed inline or held in a variable and used", () => {
    expect(ungatedExports(`export async function a() { return svc.a(await requireActor(), {}); }`)).toEqual([]);
    expect(ungatedExports(`export async function b() { const actor = await requireActor(); return svc.b(actor, {}); }`)).toEqual([]);
    expect(ungatedExports(`export async function c() { const actor = await getActor(); if (!actor) throw new Error(); }`)).toEqual([]);
  });
});

describe("every Server Action reaches a session/actor gate (AUD-095)", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"));

  it("finds the action modules", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s", (file) => {
    const src = readFileSync(path.join(dir, file), "utf8");
    expect(src.startsWith('"use server"')).toBe(true);
    const offenders = ungatedExports(src).filter((fn) => !(`${file}#${fn}` in PUBLIC_ACTIONS));
    expect(offenders, `${file}: actions without an actor gate`).toEqual([]);
  });

  it("keeps the public allow-list honest: every entry still exists", () => {
    for (const key of Object.keys(PUBLIC_ACTIONS)) {
      const [file, fn] = key.split("#");
      expect(readFileSync(path.join(dir, file), "utf8")).toMatch(new RegExp(`export async function ${fn}\\b`));
    }
  });
});
