# 文件授权与访问审计 — 设计文档

*状态：已过用户审阅（E1-E4 四段均已确认），待写实现计划。*
*日期：2026-07-30*

## 1. 背景与动机

用户提出两个需求：(1) 防止付费模板/商业内容被免费转发滥用；(2) 企业内部场景下，
审计谁打开过哪份文档（接收方知情同意，而非隐藏监控）。

**关键诚实前提，贯穿整份设计**：Bento 是单文件、view-source honest、客户端完全开源
的架构（明文JSON数据块 + 客户端可读的运行时JS）。这意味着：

- **技术上无法做到真正的访问阻断/DRM**——拿到文件的人理论上总能读到内容、改掉客户端
  校验逻辑。本设计提供的是**溯源型软保护**（水印 + 吊销提示），不是访问控制。
- 审计上报是**客户端自愿如实上报**，不是防篡改的强审计日志——任何人都能伪造上报
  请求。这一限制必须在使用说明里向企业审计场景的使用方讲清楚。

本设计**只覆盖客户端这一半**：`doc.license` 字段格式、签名验证、水印/吊销提示渲染、
离线模式下的硬阻断。用户已决定服务端（发行方Web控制台、账号体系、审计日志存储、
计费）放在一个独立的私有仓库里，不进这个公开 MIT fork——本文档只定义客户端需要的
最小 API 契约，服务端内部设计不在此展开（§5 记录了需要私有仓库覆盖的内容，供交接
参考）。

## 2. 范围

**本次设计包含（本仓库要实现的部分）：**
- E1. `doc.license` 数据模型 + 签名方案
- E2. 客户端运行时行为（验签、离线硬阻断、水印渲染、审计上报、吊销检查）
- E3. 与私有授权服务的最小接口契约（仅接口形状，不涉及服务端内部实现）
- E4. 错误处理 + 测试计划

**明确排除（记录在 §5，供私有仓库设计参考，不在本仓库实现）：**
- 发行方 Web 控制台（登录、账号体系、许可证 CRUD 界面）
- 审计日志存储、统计图表、计费
- 服务端技术栈选型、部署

## 3. 关键澄清（决定了本设计形状的几个决策点）

| 问题 | 决定 |
|---|---|
| 授权能力给谁用 | 通用能力，任何 Bento 用户都能用（多租户） |
| 发行方怎么管理许可证 | 完整 Web 控制台（登录+仪表盘）——但该控制台在私有仓库，不在本仓库 |
| 服务代码放哪 | 独立私有仓库，不进本公开 fork |
| 水印可见度 | 文档自己选（`doc.license.watermark` 开关），不是全局固定策略 |
| 许可证粒度 | 一对多：一个 `productLicenseId` 对应一款产品，多份拷贝共享；每份拷贝有各自的 `holderId` |

## 4. 设计

### 4.1 `doc.license` 数据模型 + 签名方案（E1）

```
doc.license?: {
  productLicenseId: string    // 一个产品/模板对应一个，多份拷贝共享
  holderId: string            // 买家/持有人子标识，由发行方分配
  holderName?: string         // 水印展示用的名字
  issuerPub: string           // 发行方的 ECDSA P-256 公钥（JWK），随文档走
  sig: string                 // 发行方私钥对上述字段（除 sig 自身外）的签名
  watermark: boolean          // 是否显示可见水印，文档级开关
  audit?: {
    serverUrl: string
    reportOpens?: boolean
    checkRevocation?: boolean
  }
}
```

- 签名验证复用 `kernel/src/update.ts` 已有的 ECDSA P-256 / SHA-256 模式，新增
  `kernel/src/license.ts`（同一套 crypto 原语，同一个 kernel 目录——kernel 是
  app 无关的 envelope 级机制，`update.ts` 的 update-manifest 验证已经是这类
  "frozen contract"的先例）。
- 签名的作用边界：**不是**向 Bento 证明"发行方可信"（Bento 不维护发行方白名单），
  只做防篡改——文档字段被中途改动，签名就验不过。真正的权限来源（谁能吊销、谁能
  看审计）在发行方私有服务自己的账号体系里，签名只保证文档自带的完整性证明不依赖
  服务端在线与否。

### 4.2 客户端运行时行为（E2）

新增 `kernel/src/license.ts`（app 无关，遵循 kernel/README 的 app→kernel 单向
依赖规则，任何未来的 Bento 应用——spaces/dash——都能直接复用）：

- **验签**：文档打开时若存在 `doc.license`，用内嵌的 `issuerPub` 验证 `sig`。
  验证失败 → 静默忽略整个 `doc.license`，等同于文档没有这个字段（不阻止打开，
  不报错）。
- **离线模式硬阻断**：任何网络调用前必须先查 `offlineEnabled()`（复用
  `kernel/src/update.ts` 已有的 `localStorage['bento-offline']` 开关）。
  Offline mode 打开时，`reportOpens`/`checkRevocation` 完全不生效——和现有
  "Offline mode 是硬阻断，app 会明确告知"的承诺一致，license 功能不能例外。
  水印渲染不受此限制，因为它是纯本地渲染、不发请求。
- **水印渲染**（app 侧，`slides/src/present.ts` + 编辑器画布共用同一渲染路径）：
  `doc.license.watermark===true` 时，在演示/编辑视图角落渲染持久化小水印
  （`holderName`，如"授权给：张三"），非阻挡性、不遮挡内容。
- **审计上报**：`audit.reportOpens===true` 且离线模式关闭时，文档打开后发一次
  `POST {serverUrl}/report`，body 为
  `{productLicenseId, holderId, docId, timestamp}`。**必须在 About 对话框里
  如实披露**"此文档会向 XX 服务上报打开记录"——不做静默上报（知情同意前提）。
  Fire-and-forget：失败不重试、不阻塞、不提示错误。
- **吊销检查**：`audit.checkRevocation===true` 且离线模式关闭时，同样发
  `GET {serverUrl}/status/{productLicenseId}/{holderId}`。返回 `revoked` →
  显示可关闭横幅"此授权可能已失效，请联系发行方"。**绝不阻止查看内容**（技术
  上做不到，也不应该假装能做到）。请求失败/超时 → 静默跳过，fail-open（网络
  问题不能被误读成"已吊销"）。

### 4.3 与私有授权服务的最小接口契约（E3）

客户端只需要服务端提供这两个端点，其余（账号、许可证管理界面、日志存储）完全
是服务端自己的事：

```
POST {serverUrl}/report
  body: { productLicenseId, holderId, docId, timestamp }
  → 204（客户端不解析返回内容）

GET {serverUrl}/status/{productLicenseId}/{holderId}
  → { status: "active" | "revoked" }
```

两个端点对客户端而言都是无认证的公开端点（调用方是任意查看者的浏览器，不持有
任何密钥）。**必须承认的信任上限**：任何人都能直接伪造对这两个端点的调用（比如
刷访问量、伪造吊销查询），这不是防篡改的强审计系统，是"客户端自愿如实上报"。
企业审计场景下使用这套能力时，需要向决策方说清楚这一限制，不能包装成"精确的
访问控制记录"。

### 4.4 错误处理 + 测试（E4）

| 情况 | 处理 |
|---|---|
| 签名验证失败 | 忽略整个 `doc.license`，等同不存在 |
| 离线模式开启 | 不发任何网络请求；水印仍正常显示（纯本地渲染） |
| 上报/吊销检查请求失败或超时 | 静默忽略，不提示、不重试 |
| 老文件没有 `doc.license` 字段 | 完全不受影响，正常打开（additive，符合 invariant #1）|

**测试计划**：
- 签名验证单元测试：合法签名、篡改后字段、公钥不匹配三种 case。
- Offline gate 测试：Offline mode 开启时 mock fetch，断言零网络调用。
- 水印渲染快照测试（演示模式 + 编辑器画布两处一致）。
- 吊销横幅 fail-open 行为测试：服务不可达/超时时不显示任何提示。
- 往返测试：`doc.license` 字段在保存/重新打开后原样保留（additive 字段不丢失）。

## 5. 排除范围记录（供私有仓库设计参考，不在本仓库实现）

以下内容用户已决定放在独立私有仓库，这里记录下来避免遗漏，作为那边设计工作的
输入，而不是本仓库的实现任务：

- **发行方账号体系**：注册/登录、多租户隔离（每个发行方只能管理/查看自己名下的
  `productLicenseId`）。
- **Web 控制台**：创建/吊销许可证的界面、按 `holderId` 批量下发（对应"一对多"
  的许可证粒度）、访问统计仪表盘（把 `/report` 收到的事件可视化）。
- **审计日志存储**：`{productLicenseId, holderId, docId, timestamp}` 事件的
  持久化、查询、留存策略；需要考虑上报数据可被伪造这一前提对统计可信度的影响
  （§4.3 已记录，建议界面上如实标注"客户端自报数据，非强审计"）。
- **计费**（如果按许可证数量或按访问量计费）。
- **服务端技术栈选型与部署**：不要求跟随本仓库现有 `server/sync-worker`（
  Cloudflare Worker + Durable Objects）的技术选型；用户倾向自己的自托管基础
  设施（K8s / devops namespace / Traefik IngressRoute / registry.yun.local），
  这属于私有仓库自己的决定。
- **`/report` `/status` 两个端点以外的 API 面**：如果私有仓库需要更多接口
  （比如许可证批量导入、webhook 通知），客户端不关心，不需要反映到
  `doc.license` 字段里，除非将来客户端需要消费新的响应字段。
