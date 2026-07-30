// Node ESM 原生 TS stripping 不会像 tsc/Vite(bundler moduleResolution) 那样
// 自动给无后缀的相对导入(如 './model')补 .ts 后缀。这是个极小的 resolve
// hook：常规解析失败、且是相对/绝对路径、且本身没有后缀名时，依次尝试补
// .ts/.tsx 再解析一次。只给本地验证脚本(scripts/test-*.ts)用，不影响
// tsc/Vite 的真实构建产物。
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) {
        try { return await nextResolve(specifier + ext, context) } catch { /* try next extension */ }
      }
    }
    throw err
  }
}
