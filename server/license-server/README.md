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

## 部署
```bash
docker build -t registry.yun.local/devops/bento-license:20260906 . && docker push registry.yun.local/devops/bento-license:20260906
kubectl -n devops create secret generic bento-license-admin --from-literal=token=xxx
kubectl apply -f k8s.yaml
```
