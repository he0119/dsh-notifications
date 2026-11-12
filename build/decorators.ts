/** Compile standard decorators before the Node bundle reaches plain JavaScript. */
import ts from 'typescript'
/** @param code - original module text. @param id - source file id. @returns lowered JavaScript and its map when decorators are present. */
export function transformDecorators(code: string, id: string) {
  const path = id.split('?', 1)[0]!
  if (!/\.[cm]?tsx?$/.test(path) || !/^\s*@[A-Za-z_$]/m.test(code)) return
  const result = ts.transpileModule(code, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true } })
  return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
}
