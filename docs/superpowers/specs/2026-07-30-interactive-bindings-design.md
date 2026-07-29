# BI 风格交互式绑定 — 设计文档

*状态：已过用户审阅（A/B/C/D 四段均已确认），待写实现计划。*
*日期：2026-07-30*

## 1. 背景与动机

Bento/slides 目前的图表-表格联动是单向、静态的：`chart.source={tableId}` 把表格数据
渲染成图表，但没有任何"筛选、交叉筛选、钻取、观众输入"这类 BI 仪表盘常见的交互能力。
本设计给 bento/slides 加入一套响应式数据绑定层，让筛选器、图表点击、观众输入之间可以
声明式地互相联动，同时不违反 Bento 现有的核心不变量：

- **单文件、离线优先**：不引入外部/实时数据源（数据源仍是文档内嵌的 `table` 元素）。
- **文档不可夹带可执行代码**（`docs/architecture.md` format invariant #3）：所有绑定/
  计算都是受限文法的纯字符串表达式，用手写递归下降解析器求值，绝不走 `eval`/`Function`。
- **向后兼容**：所有新字段都是可选、additive 的（invariant #1），老文件在新 shell 里
  照常打开。

## 2. 范围

**本次设计包含：**
- A. 响应式绑定引擎（`interact.ts`：运行时 store + 绑定表达式文法 + 计算属性 + 依赖追踪）
- B. 新元素类型 `filter`/`input`；图表交叉筛选与钻取（复用绑定引擎 + 现有 `link` 机制）
- C. 可复用组件（在现有 `layouts` 模板机制上做参数化扩展）
- D. 保存工作流（公版/私人版）+ 渲染/编辑器集成 + 错误处理 + 测试计划

**明确不包含（用户已确认延后/另立）：**
- 外部/实时数据源连接（违反离线不变量，用户已决定本轮不做）
- "文件访问权限 + 中央授权/审计服务"——完全独立的子系统，将作为下一轮单独的 brainstorm

## 3. A. 响应式绑定引擎

### 3.1 运行时状态层

新增 `slides/src/interact.ts`（app 层模块，不进 `kernel/`，因为语义是 slides 专属）：

```ts
interface InteractState {
  values: Record<string, unknown>   // 键形如 "filter.region" / "input.budget" / "params.x"
}
```

- 极简 pub-sub：`interact.set(key, value)` / `interact.get(key)` / `interact.subscribe(key, cb)`。
  不用 Vue 式 Proxy 深度响应式——避免代理陷阱边界情况，且刻意保持"store 是运行时对象，
  不是文档内容"这条边界，不给"文档执行代码"开口子。
- **两层持久化**：
  1. 编辑/演示过程中先写 `localStorage`（key: `bento:interact:<docId>`），会话缓存，
     刷新页面不丢失当前筛选/输入值。
  2. 只有用户显式触发"保存到文件"时，才把当前值整体写入文档新增可选字段
     `doc.interactState?: Record<string, unknown>`，随后走现有 `save.ts` 正常保存流程
     （不改动 save.ts 核心逻辑，只是多一个可选字段）。

### 3.2 绑定表达式语法

扩展现有的动态字段 token 机制（`{{page}}` / `{{title}}` 等，`render.ts`/`present.ts` 里
已有的纯数据 token 解析器）。新 token 形如：

- `{{filter.region}}` — 读某个 filter 控件当前选中值
- `{{input.budget}}` — 读某个观众输入框当前值
- `{{params.region}}` — 读组件实例的参数值（见 §5）
- `{{computed.total}}` — 读计算属性结果（见 3.3）

任何"可绑定"的元素属性（text 的 `html`、shape 的 `fill`、visibility、chart 的
`source`、image 的 `src` key）在渲染前经过 `resolveBindings(value, ctx)` 求值一遍。

### 3.3 计算属性

- Slide（或 doc）级新增可选字段 `computed?: Record<string, string>`——名字 → 表达式
  字符串。
- 表达式文法**白名单**、手写递归下降解析（不是 `eval`/`Function`）：
  - 函数：`sum() avg() count() min() max()`（作用于表格列引用）
  - 运算符：`+ - * /`、比较 `== != > < >= <=`、三元 `cond ? a : b`
  - 变量引用：`filter.x` / `input.x` / `params.x` / `table.<id>.<col>`
- 语义上像 Vue 的 `computed`，物理上和 `element.html` 的 sanitizer 白名单同一套哲学——
  纯数据字符串，不可能夹带可执行代码。

### 3.4 依赖追踪

- 对每个绑定表达式字符串做一次静态解析，提取它引用了哪些 `filter./input./params./
  computed.` key，构建"key → 依赖它的元素/computed"依赖图。
- 某个 key 变化时，只重渲染依赖它的元素，不做整页重渲染。
- **循环依赖**：计算属性求值时维护一个求值栈，检测到环则该 computed 渲染为 `#ERROR`，
  不递归、不死循环、不抛出异常导致页面崩溃。

## 4. B. 新元素类型 + 交叉筛选/钻取

### 4.1 FilterElement（`type: 'filter'`）

```
kind: 'select' | 'multiselect' | 'slider' | 'date-range'
key: string                              // 写入 interact 的哪个绑定名
optionsSource?: { tableId: string; column: string }  // 从表格某列自动取选项
options?: string[]                       // 或手写选项
label?: string
default?: string
```

- `select` 存单个字符串值；`multiselect` 存字符串数组；`date-range` 存
  `{start, end}` 对象。绑定表达式对这三种值的处理规则：
  - `select` → `{{filter.x}}` 直接插值该字符串
  - `multiselect` → 表格行过滤时按"包含任一选中值"语义（相当于隐式 `IN`），字符串
    插值时用顿号拼接（如 `华东、华南`）
  - `date-range` → 只能用于表格行过滤（按行的日期列判断是否落在区间内），不支持
    直接字符串插值到 `{{filter.x}}`（无自然的单值表示）

### 4.2 InputElement（`type: 'input'`）

```
kind: 'text' | 'number' | 'date'
key: string
label?: string
placeholder?: string
default?: string
```

两者都是普通 `SlideElement`（共享 x/y/w/h/id 等公共字段），走同一个 `render.ts` 渲染成
真实 `<select>`/`<input>` DOM；编辑器画布和演示模式渲染逻辑一致（同一渲染器、多场景，
符合现有"一个渲染器，四个场景"架构）。

### 4.3 交叉筛选 + 钻取：复用同一机制，不建新概念

- 图表新增可选字段 `chart.filterKey?: string`：点击图表上的一个数据点，等价于
  `interact.set(filterKey, clickedLabel)`——和 filter 下拉框写入的是同一个 store，因此
  "点图表联动别的图表/表格"和"filter 控件联动"共用同一套重渲染路径。
- 钻取 = 交叉筛选 + 现有的 `link` 字段。图表元素本来就可以有 `link`（点击跳转到某
  slide，`present.ts` 现有的 slide-jump 逻辑）。点击时既写入 `filterKey`（若配置了）
  又照常跳转——目标 slide 打开时，绑定它的 filter 状态已经设置好，落地即是"钻取后"
  的过滤视图。不新增"drill"这个独立概念。
- 作用域不用额外的"filterGroup"标签：哪个元素的绑定表达式引用了 `{{filter.region}}`，
  哪个元素才会因为 `region` 变化而重渲染，天然限定作用域。
- **MVP 范围限定**：`filterKey` 点击写入仅支持有离散类目的图表（bar/pie）——点击的
  类目标签即写入值。line/scatter 这类连续型图表的点击钻取行为留到后续迭代，本次不做
  （避免"点一个连续曲线上的点该写入什么值"这个语义不清楚的问题）。

## 5. C. 可复用组件（参数化模板）

在现有 `layouts: Slide[]` 机制（模板 slide，实例化时保留元素 id）上做参数化扩展：

- Layout 新增可选字段 `params?: string[]`——具名参数列表，如
  `['region', 'accentColor']`。
- **实例化**时，除现有"保留元素 id"逻辑外，额外生成 `paramValues:
  Record<string,string>`，挂在实例化出来的 slide/元素组上（新增可选字段，additive）。
- 组件内部绑定表达式里的 `{{params.x}}`，求值时先查实例自己的 `paramValues`，查不到
  再落到全局 `filter/input/computed` 命名空间（作用域链，等价于 JS 闭包变量查找）。
- 效果：同一个"KPI 卡片"布局可以在同一页/不同页放多份实例，各自的 `paramValues`
  不同（如 `region: '华东'` vs `region: '华南'`），共享同一套绑定表达式和视觉设计，
  显示不同数据。
- 编辑体验：实例化后，编辑器属性面板给这份实例新增一个"参数"分区，列出
  `params.*` 当前值可编辑，复用现有图层属性面板 UI 范式，不引入新的交互模式。
- `params.` 和 `filter.` 是两个独立命名空间，可以在同一组件实例内混用（比如实例内
  图表同时读全局 `{{filter.dateRange}}` 和实例专属 `{{params.region}}`）。

## 6. D. 保存工作流 + 渲染集成 + 错误处理 + 测试

### 6.1 保存工作流

复用现有 pristine-clone save 架构，不改动 `save.ts` 核心：

- **「保存当前状态到文件」**：把 `interact` store 的当前值整体写入 `doc.interactState`，
  再照常调用现有 `save()`。收件人打开文件看到的就是发送者演示时的筛选/输入状态。
- **「清空并存为公版模板」**：`doc.interactState` 置空（或重置到各 filter/input 的
  `default`），再 `save()`，产出干净模板。
- 两个动作放在 File/About 菜单，位置逻辑类似现有的"Duplicate as new deck"；不新增
  文件格式概念，只是"何时把运行时状态 merge 进文档 model"的两条路径。

### 6.2 渲染/编辑器集成

- `render.ts` 新增 `filter`/`input` 两种元素的 DOM 渲染分支；`present.ts` 和编辑器
  画布共享同一渲染调用。
- 渲染前扩展现有 token resolver，对含 `{{...}}` 的属性求值一遍；编辑器画布用各绑定
  的 `default`/示例值求值预览，不需要进入 present 模式就能看到联动效果。
- `interact.subscribe(key, cb)` 触发时，只重渲染依赖图中挂在该 key 下的元素。

### 6.3 错误处理（原则：fail-open，绝不崩页面）

| 情况 | 处理 |
|---|---|
| 表达式解析失败 | 原样渲染 token 字面量；编辑器内 inline lint 提示（仅编辑态可见） |
| 引用不存在的 filter/input/param key | 解析为空字符串 |
| 计算属性循环依赖 | 求值栈检测到环 → 渲染 `#ERROR`，不递归、不崩溃 |
| 组件实例缺某个 param | 落到该 param 在 layout 里声明的默认值 |
| 老文件没有这些新字段 | 全部新字段 optional，正常打开（invariant #1） |

### 6.4 测试计划

- 表达式解析器单元测试：合法/非法表达式、白名单函数覆盖率、确认不存在
  `eval`/`Function` 调用路径。
- 依赖图测试：循环依赖检测；"改一个 key 只重渲染依赖它的元素"这条不误触发无关
  元素重渲染的断言。
- 组件参数作用域链测试：实例值优先于全局值；缺省时正确落到 layout 声明的默认值。
- 存档往返测试：保存 → 清空 → 再保存 三种路径产出的 `doc.interactState` 内容符合
  预期；额外字段不破坏老版本编辑器打开新文件（前向兼容抽查）。

## 7. 新增/变更的文档模型字段一览（均为可选、additive）

```
BentoDoc
├─ interactState?: Record<string, unknown>     // §3.1 运行态快照
├─ computed?: Record<string, string>           // §3.3 计算属性（doc 或 slide 级）
└─ layouts?: Slide[]
   └─ params?: string[]                        // §5 组件参数声明

Slide
└─ computed?: Record<string, string>           // slide 级计算属性覆盖

SlideElement（新增两种 type）
├─ type: 'filter'  { kind, key, optionsSource?, options?, label?, default? }
└─ type: 'input'   { kind, key, label?, placeholder?, default? }

ChartElement
└─ filterKey?: string                          // §4.3 交叉筛选写入键

实例化出的 Slide/元素组（来自带 params 的 layout）
└─ paramValues?: Record<string, string>        // §5 组件实例参数值
```

## 8. 后续（明确排除在本次实现范围外）

- 外部/实时数据源绑定（用户已决定暂不做，保持离线不变量）
- 文件级授权/访问统计的中央服务（下一轮独立 brainstorm）
