/**
 * A TRANSACTION CALLBACK MAY NOT CHANGE ANYTHING OUTSIDE ITSELF.
 *
 * Firestore runs a transaction callback once per ATTEMPT and rolls back every
 * attempt but the one that commits. Anything the callback changes outside the
 * transaction — a variable declared around it, an array or map it pushes into,
 * a document written directly instead of through `tx` — survives the
 * rolled-back attempts. `redeemQuickLogin` recorded its success that way
 * (`consumed = true`), and under real contention every loser of a race minted a
 * session (the 2026-10-20 cross-system emulator run). The fix returns the
 * decision from the callback, which `runTransaction` resolves to only for the
 * attempt that committed.
 *
 * This walks every `runTransaction(callback)` in functions/src with the
 * TypeScript compiler and fails on any assignment to, or mutation of, a name the
 * callback did not declare itself. The test fake cannot catch this class of bug
 * in general (it retries only in its optimistic mode), so the rule is checked on
 * the source, for all of them.
 *
 * Run:  node --test test/transactionPurity.test.js
 */

const { test } = require('node:test')
const { expect } = require('./expect')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const SRC = path.join(__dirname, '..', 'src')
const MUTATORS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'add', 'set', 'delete', 'clear', 'update', 'create'])
const ASSIGN = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
])

function declaredIn(fn) {
  const names = new Set()
  const bind = (n) => {
    if (!n) return
    if (ts.isIdentifier(n)) names.add(n.text)
    else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n.elements.forEach((e) => e.name && bind(e.name))
  }
  fn.parameters.forEach((p) => bind(p.name))
  const walk = (n) => {
    if (ts.isVariableDeclaration(n)) bind(n.name)
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n !== fn) {
      if (n.name) bind(n.name)
      n.parameters.forEach((p) => bind(p.name))
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) bind(n.variableDeclaration.name)
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(fn.body, walk)
  return names
}

function rootName(expr) {
  let e = expr
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression
  return ts.isIdentifier(e) ? e.text : null
}

function violations() {
  const out = []
  let callbacks = 0
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'runTransaction' && node.arguments.length > 0
          && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))) {
        callbacks += 1
        const fn = node.arguments[0]
        const inside = declaredIn(fn)
        const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
        const scan = (n) => {
          if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind)) {
            const name = rootName(n.left)
            if (name && !inside.has(name)) out.push(`${at(n)} assigns '${n.left.getText()}' (declared outside the callback)`)
          }
          if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
              && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
            const name = rootName(n.operand)
            if (name && !inside.has(name)) out.push(`${at(n)} increments '${n.operand.getText()}' (declared outside the callback)`)
          }
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
              && MUTATORS.has(n.expression.name.text)
              // `FieldValue.delete()` builds a sentinel; it changes nothing.
              && !/(^|\.)FieldValue$/.test(n.expression.expression.getText())) {
            const name = rootName(n.expression.expression)
            if (name && !inside.has(name)) {
              out.push(`${at(n)} calls '${n.expression.getText()}(…)' on something declared outside the callback`
                + ' (a write not through the transaction, or state that survives a rolled-back attempt)')
            }
          }
          ts.forEachChild(n, scan)
        }
        ts.forEachChild(fn.body, scan)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { out, callbacks }
}

test('every transaction callback in functions/src changes nothing outside itself', () => {
  const { out, callbacks } = violations()
  expect(callbacks >= 30).toBe(true)                 // the scan found them (30 on 2026-10-20)
  expect(out).toEqual([])
})

test('redeemQuickLogin takes its decision from the committed attempt', () => {
  const src = fs.readFileSync(path.join(SRC, 'quickLogin.ts'), 'utf8')
  // Code only: the explanation of the old bug in the comments quotes it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  expect(code.includes('consumed = await store().runTransaction(async (tx): Promise<boolean> => {')).toBe(true)
  expect(/consumed\s*=\s*true/.test(code)).toBe(false)
})
