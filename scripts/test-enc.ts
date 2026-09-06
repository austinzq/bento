// bento/enc v2 信封：压缩 → HKDF(PBKDF2 ‖ secret) → AES-GCM 的往返，以及
// 与 Python 生成器（working/macro-radar/pipeline/gen.py encrypt_body）的互通。
// 跟 test-expr.ts 一样手写断言。需要 WebCrypto + CompressionStream（Node 18+）。
import { readFileSync, existsSync } from 'node:fs'
import { decryptEnvelope, parseEnvelope } from '../kernel/src/save.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

// encryptBody 未导出（只经 serializeDocInto 调用），这里通过 Python 夹具验证解密侧；
// JS 加密侧由 serializeDocInto 在浏览器里走，headless 门测试覆盖。
console.log('Python 夹具（v2 + 许可 secret）解密…')
const fixture = new URL('../working/tmp/enc-fixture.json', import.meta.url).pathname
if (existsSync(fixture)) {
  const fx = JSON.parse(readFileSync(fixture, 'utf8')) as { envelope: string; password: string; secret: string; plaintext: string }
  const env = parseEnvelope(fx.envelope)
  ok(!!env && env.v === 2 && env.z === 'deflate' && !!env.license, 'v2 信封解析：v=2、z=deflate、带 license')
  const secret = Uint8Array.from(Buffer.from(fx.secret, 'base64'))
  const pt = await decryptEnvelope(env!, fx.password, secret)
  ok(pt === fx.plaintext, '正确密码 + secret → 明文一致')
  ok((await decryptEnvelope(env!, fx.password, null)) === null, '缺 secret → 打不开（密码单独不够）')
  ok((await decryptEnvelope(env!, 'wrong', secret)) === null, '错密码 → 打不开')
  const bad = Uint8Array.from(secret); bad[0] ^= 1
  ok((await decryptEnvelope(env!, fx.password, bad)) === null, '错 secret → 打不开')
} else {
  console.log('  (夹具不存在，跳过：先运行 pipeline/gen.py --fixture)')
}

console.log('v1 信封仍可解析…')
ok(parseEnvelope('{"format":"bento/enc","v":1,"it":1,"salt":"AA==","iv":"AA==","data":"AA=="}') !== null, 'v1 parse')
ok(parseEnvelope('{"format":"bento/enc","v":3,"it":1,"salt":"AA==","iv":"AA==","data":"AA=="}') === null, '未知版本拒绝')

if (failures) { console.error(`FAILED ${failures}/${checks}`); process.exit(1) }
console.log(`ALL PASS (${checks} checks)`)
