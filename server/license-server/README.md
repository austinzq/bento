# bento 许可服务器

给 `bento/enc` v2 加密文件发放解密密钥的一半，实现"打开时联网校验 + 可设置最长脱网天数 + 吊销"。
协议见 `kernel/src/license.ts` 顶部注释；客户端永远不把密码发上来，只发 `sha256(id:password)`。

## 本地跑
```bash
ADMIN_TOKEN=xxx LICENSE_DB=./data/licenses.json python3 app.py      # 端口 5197
```

## 发放 / 管理
```bash
H='X-Admin-Token: xxx'; U=http://localhost:5197
curl -X PUT $U/v1/licenses/mr-202609-GT001 -H "$H" -H 'content-type: application/json' \
  -d '{"holder":"张三 GT001","proof":"<sha256(id:password)>","secret":"<32B base64>","expires":"2026-12-31","maxOfflineDays":7}'
curl $U/v1/licenses -H "$H"                          # 列表 + 打开次数
curl $U/v1/licenses/mr-202609-GT001/opens -H "$H"    # 打开记录（时间 / IP / UA / 密码是否正确）
curl -X POST $U/v1/licenses/mr-202609-GT001/revoke -H "$H"
```
改 `maxOfflineDays` / `expires` 后，持有人下次联网打开即生效；脱网期内仍按缓存里的旧值。

## 访问统计（不依赖许可）
文件带 `doc.analytics = {url, id}` 就会在打开时 `POST <url>/v1/open`（text/plain 正文，简单请求，无预检，
file:// 打开也能报），演示时按页累计停留秒数，切走/关闭时用 sendBeacon 一次发出。只发不拦：服务器不在也照常打开；
离线打开会存本地队列，下次联网打开任何一份文件时补发。

```bash
curl $U/v1/opens -H "$H"                 # 按文件编号汇总：打开次数、最近打开、观看者、打开方式、每页累计秒数、总观看秒数
curl $U/v1/opens/mr-202609-GT001-L -H "$H"   # 原始事件（open / pages）
curl -X DELETE $U/v1/opens/mr-202609-GT001-L -H "$H"   # 清空该编号（测试污染 / 重发文件后归零）
```
限制：上报地址必须 https（文件经 https 打开时 http 上报被浏览器丢弃）；接口路径故意不叫 analytics/track，避开广告拦截。
存储 `STATS_DB`（默认与许可库同目录 `opens.json`），每个编号保留最近 2000 条事件。

## 部署
```bash
docker build -t registry.yun.local/devops/bento-license:20260907 . && docker push registry.yun.local/devops/bento-license:20260907
kubectl -n devops create secret generic bento-license-admin --from-literal=token=xxx
kubectl apply -f k8s.yaml
```
已于 2026-09-07 部署：内网 http://lic.yun.local，公网 https://lic.zcpz.cc（公网还需在 gateway.zcpz.cc 面板加白子域 `lic`，已加）。
清单里避开 n3 节点（Longhorn 卷在 n3 格式化失败）并用 Recreate 策略（单副本 RWO 卷）。
