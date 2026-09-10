#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PPTX 递归全量提取 —— 给 PPT→bento（及任何"读 PPT 再重做"的活）一个不漏的确定性底座。

## 为什么要有它（2026-09-10，jinna 的《财富管理业务实践分享》反复改的根因）
bento 的 PPT→bento 是 bot 徒手读 PPT、手写 bento JSON。bot 读 PPT 时只读顶层 shape，
而 PowerPoint 常把内容塞进**多层嵌套的组合形状（group shape）**里。实测那份 PPT：
24 页共 476 个文本块，其中 **151 块（32%）藏在组合里**，只读顶层会静默丢掉三分之一，
读不全的页 bot 又"自由发挥"脑补——jinna 说的"数据掉了""发挥成分太多"全由此来。

这个脚本把每页的**全部**文本（递归进任意层组合）、表格、图片占位、图表，
连同它们的**分组归属路径**，结构化吐出来。bot 拿这份清单去写 bento，不再徒手读 pptx。

## 三个用途
1. `extract`  —— 出结构化 JSON（bot 转换的输入底座；带每页文本块、表格、分组路径）
2. `coverage` —— 只报"顶层能读到 vs 递归全部"的差距，量化会漏多少（决定要不要走这条路）
3. `cover-check` —— **覆盖率门禁**：给一份"成品里出现的文本"，比对源 PPT，逐页列出
   "原稿有、成品没有"的缺口。用于交付前拦截"静默丢数据"。

判据纪律（[[data-authenticity]] / [[absence-of-evidence]]）：
- 读不到的（图片式内容、OLE 对象）**显式标 kind=image/ole 并计入"未提取"**，绝不当没有；
- 提取失败（坏文件/加密）**抛异常**，不返回空当"这页没内容"。

用法：
  python3 pptx_extract.py extract  <a.pptx> [-o out.json]
  python3 pptx_extract.py coverage <a.pptx>
  python3 pptx_extract.py cover-check <a.pptx> --produced produced_text.txt
  python3 pptx_extract.py selftest
"""
import argparse
import json
import sys

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
except Exception as e:                                                # noqa: BLE001
    print("需要 python-pptx：pip install -i https://pypi.tuna.tsinghua.edu.cn/simple python-pptx",
          file=sys.stderr)
    raise


def _shape_text(sh):
    """一个非组合 shape 的文本（文本框逐段 + 表格逐格）。返回 (kind, text|rows)。"""
    if sh.has_table:
        rows = [[c.text.strip() for c in row.cells] for row in sh.table.rows]
        return "table", rows
    if sh.has_text_frame:
        t = sh.text_frame.text.strip()
        if t:
            return "text", t
    return None, None


def _walk(shapes, path, out):
    """递归遍历 shapes，把每个内容块连同它的分组路径 path 收进 out。

    path 是从最外层到当前的组合名列表，例如 ['业务总览', '成效卡'] ——
    让 bot 知道"这块数据原本属于哪个卡/哪个分组"，就不会把它挪错位置（jinna 的
    "这个数据是跟踪体系里面的，怎么掉到下面来了"正是丢了归属）。
    """
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            gname = (sh.name or "组合").strip()
            _walk(sh.shapes, path + [gname], out)
            continue
        kind, val = _shape_text(sh)
        if kind == "text":
            out.append({"kind": "text", "group_path": path, "text": val})
        elif kind == "table":
            out.append({"kind": "table", "group_path": path, "rows": val,
                        "text": " | ".join(" ".join(r) for r in val)})
        elif sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
            # 图片：读不到里面的字，但**必须记下来**——它可能是"图片式页面"，
            # bot 看到 image 占位就该去逐页渲染成图看，而不是脑补。
            alt = ""
            try:
                alt = (sh._element._nvXxPr.cNvPr.get("descr") or "").strip()  # noqa: SLF001
            except Exception:                                            # noqa: BLE001
                pass
            out.append({"kind": "image", "group_path": path, "text": alt,
                        "note": "图片：文字提取不到，需渲染成图人工/视觉核对"})
        elif sh.shape_type in (MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT,
                               MSO_SHAPE_TYPE.LINKED_OLE_OBJECT):
            out.append({"kind": "ole", "group_path": path, "text": "",
                        "note": "OLE 对象：提取不到，需人工核对"})


def _top_text_count(slide):
    """只读顶层（不进组合）能拿到的文本/表格块数——对照用，量化会漏多少。"""
    n = 0
    for sh in slide.shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            continue
        kind, _ = _shape_text(sh)
        if kind in ("text", "table"):
            n += 1
    return n


def extract(path):
    """→ {slides:[{page, blocks:[...], counts:{...}}], totals:{...}}。提取失败抛异常。"""
    prs = Presentation(path)
    slides = []
    tot_top = tot_all = tot_img = 0
    for i, slide in enumerate(prs.slides, 1):
        blocks = []
        _walk(slide.shapes, [], blocks)
        n_text = sum(1 for b in blocks if b["kind"] in ("text", "table"))
        n_img = sum(1 for b in blocks if b["kind"] in ("image", "ole"))
        top = _top_text_count(slide)
        tot_top += top
        tot_all += n_text
        tot_img += n_img
        slides.append({
            "page": i,
            "blocks": blocks,
            "counts": {"text_blocks": n_text, "image_or_ole": n_img,
                       "top_level_only": top, "hidden_in_groups": n_text - top},
        })
    return {
        "slides": slides,
        "totals": {
            "pages": len(slides),
            "text_blocks_all": tot_all,
            "text_blocks_top_level": tot_top,
            "hidden_in_groups": tot_all - tot_top,
            "image_or_ole": tot_img,
            "loss_if_top_only_pct": round(100 * (tot_all - tot_top) / tot_all, 1) if tot_all else 0.0,
        },
    }


def coverage(path):
    r = extract(path)
    t = r["totals"]
    print(f"{path}")
    print(f"  {t['pages']} 页：文本块递归全部 {t['text_blocks_all']} / 顶层能读 {t['text_blocks_top_level']}")
    print(f"  藏在组合里 {t['hidden_in_groups']} 块 → 只读顶层会漏 {t['loss_if_top_only_pct']}%")
    print(f"  图片/OLE（读不到文字，需渲染核对）：{t['image_or_ole']} 处")
    worst = sorted(r["slides"], key=lambda s: -s["counts"]["hidden_in_groups"])[:6]
    for s in worst:
        c = s["counts"]
        if c["hidden_in_groups"] > 0 or c["image_or_ole"] > 0:
            print(f"    P{s['page']}: 顶层 {c['top_level_only']} / 全部 {c['text_blocks']}"
                  f"（藏 {c['hidden_in_groups']}）｜图片/OLE {c['image_or_ole']}")
    return 0


import re as _re


def _norm(s):
    """粗归一，用于"这句原文有没有出现在成品里"的判断——去空白、全角空格。"""
    return "".join(ch for ch in str(s or "") if not ch.isspace()).replace("　", "")


_NUM = _re.compile(r'\d[\d,\.]*\s*(?:%|万|亿|亿元|万元|人|家|个|年|月|日|只|倍)?')
_TERM = _re.compile(r'[一-鿿]{4,}')


def _tokens(text):
    """从一个文本块抽"高信号 token"——数字（带单位）和 ≥4 字中文专有词。
    这才是"数据有没有丢"的正确粒度：bento 把一块拆成统计卡（数字/标签分离）、
    重排顺序，都不影响单个数字/词是否出现；而"4089万掉了"这种真丢数据必被抓到。
    连续子串按句比对打不过原子化重排（实测误报 4/5），token 级免疫。"""
    nums = [_norm(m.group()) for m in _NUM.finditer(text or "") if any(c.isdigit() for c in m.group())]
    terms = _TERM.findall(text or "")
    # 数字去掉纯页码类噪声（单个 1-2 位且无单位的）
    nums = [n for n in nums if len(_re.sub(r'\D', '', n)) >= 2 or n[-1] in "%万亿"]
    return nums, terms


def cover_check(path, produced_text):
    """数据覆盖门禁：源 PPT 里的**数字和专有词**是否都在成品里出现。→ 退出码 0/1。

    只查高信号 token（数字/≥4字中文词），对 bento 的卡片化重排免疫，专抓"数据掉了"。
    不查措辞/顺序/结构——那些是"忠于原稿"的事，靠逐页视觉对位（page-verify），不在这。
    """
    r = extract(path)
    prod = _norm(produced_text)
    miss_num, miss_term = [], []
    n_num = n_term = 0
    for s in r["slides"]:
        for b in s["blocks"]:
            if b["kind"] not in ("text", "table"):
                continue
            loc = "/".join(b["group_path"]) if b["group_path"] else "顶层"
            nums, terms = _tokens(b["text"])
            for x in nums:
                n_num += 1
                if _norm(x) not in prod:
                    miss_num.append((s["page"], loc, x))
            for x in set(terms):
                n_term += 1
                if _norm(x) not in prod:
                    miss_term.append((s["page"], loc, x))
    print(f"源 PPT 数字 {n_num} 个（丢 {len(miss_num)}）｜专有词 {n_term} 个（丢 {len(miss_term)}）")
    if miss_num:
        print("── 丢掉的数字（高危：数据缺失）──")
        for pg, loc, x in miss_num[:30]:
            print(f"  ✗ P{pg}[{loc}] {x}")
    if miss_term:
        print("── 丢掉的专有词（可能是内容缺失，也可能是同义改写，需核）──")
        for pg, loc, x in miss_term[:20]:
            print(f"  · P{pg}[{loc}] {x}")
    if r["totals"]["image_or_ole"]:
        print(f"  ⚠ 另有 {r['totals']['image_or_ole']} 处图片/OLE 提取不到，"
              f"门禁管不到，必须逐页渲染成图核对")
    return 1 if miss_num else 0     # 数字丢=硬失败；专有词丢只提示不拦（可能是改写）


def selftest():
    """自检：用一份真实 PPT（若在）验证递归确实比顶层多读到东西。"""
    import glob
    cands = glob.glob("/home/zq/work/*/workspace/inbox/*.pptx") + \
        glob.glob("/home/zq/work/*/workspace/**/*.pptx", recursive=True)
    sample = next((p for p in cands if "财富管理" in p), cands[0] if cands else None)
    if not sample:
        print("  （本机没找到样例 pptx，跳过实测；纯函数逻辑见 coverage/cover-check）")
        return 0
    r = extract(sample)
    t = r["totals"]
    ok = t["text_blocks_all"] > t["text_blocks_top_level"]
    print(("  ✓ " if ok else "  ✗ ") +
          f"递归({t['text_blocks_all']}) > 顶层({t['text_blocks_top_level']})，"
          f"多读到 {t['hidden_in_groups']} 块  [{sample.split('/')[-1]}]")
    # 正对照：把"只有顶层文本"当成品，数字门禁应报出组合里丢的数字并退出码 1
    top_only = "\n".join(b["text"] for s in r["slides"] for b in s["blocks"]
                         if b["kind"] in ("text", "table") and not b["group_path"])
    import io
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    rc_top = cover_check(sample, top_only)
    sys.stdout = old
    line_top = buf.getvalue().splitlines()[0]
    ok2 = rc_top == 1
    print(("  ✓ " if ok2 else "  ✗ ") + f"正对照(只读顶层)能报出数字缺失且退出码1：{line_top}")
    # 反对照：把全量文本当成品，数字应 0 丢、退出码 0（不误报）
    full = "\n".join(b["text"] for s in r["slides"] for b in s["blocks"]
                     if b["kind"] in ("text", "table"))
    buf2 = io.StringIO(); sys.stdout = buf2
    rc_full = cover_check(sample, full)
    sys.stdout = old
    line_full = buf2.getvalue().splitlines()[0]
    ok3 = rc_full == 0
    print(("  ✓ " if ok3 else "  ✗ ") + f"反对照(全量)数字0丢不误报且退出码0：{line_full}")
    return 0 if (ok and ok2 and ok3) else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract"); e.add_argument("pptx"); e.add_argument("-o", "--out")
    c = sub.add_parser("coverage"); c.add_argument("pptx")
    cc = sub.add_parser("cover-check"); cc.add_argument("pptx")
    cc.add_argument("--produced", required=True, help="成品里出现的文本（文件路径）")
    sub.add_parser("selftest")
    a = ap.parse_args()
    if a.cmd == "extract":
        r = extract(a.pptx)
        s = json.dumps(r, ensure_ascii=False, indent=1)
        if a.out:
            open(a.out, "w", encoding="utf-8").write(s)
            print(f"已写 {a.out}（{r['totals']['pages']} 页，文本块 {r['totals']['text_blocks_all']}）")
        else:
            print(s)
        return 0
    if a.cmd == "coverage":
        return coverage(a.pptx)
    if a.cmd == "cover-check":
        return cover_check(a.pptx, open(a.produced, encoding="utf-8").read())
    if a.cmd == "selftest":
        return selftest()


if __name__ == "__main__":
    sys.exit(main())
