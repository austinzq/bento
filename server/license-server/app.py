# -*- coding: utf-8 -*-
"""bento 文件许可服务器（最小实现）

一份加密的 .bento.html 在打开时向这里换取解密密钥的一半（secret）：
  POST /v1/key/<license_id>  {proof, holder}
      proof = sha256("<license_id>:<password>")，证明持有人知道密码但不传密码本身
      → 200 {status:'active', secret, checkedAt, maxOfflineDays, expires}
      → 200 {status:'revoked'|'expired'|'bad_proof'}
客户端把 secret 用密码加密后缓存在本地，最多 maxOfflineDays 天不联网也能打开；
超过就必须再来一次。吊销 / 改到期日 / 改脱网天数都在这里改，下次联网即生效。

管理接口（请求头 X-Admin-Token）：
  GET    /v1/licenses                 列出全部许可与打开记录
  PUT    /v1/licenses/<id>            创建或更新 {holder, proof, secret, expires, maxOfflineDays}
  POST   /v1/licenses/<id>/revoke     吊销
  POST   /v1/licenses/<id>/restore    恢复
存储：单个 JSON 文件（LICENSE_DB，默认 ./data/licenses.json），够用且好备份。

访问统计（与许可无关，文件带 doc.analytics 就上报，不拦人）：
  POST   /v1/open                     正文 text/plain 的 JSON：{t:'open'|'pages', id, docId, viewer, at, ...}
                                      简单请求，无预检；file:// 打开的文件也能报。总是 204。
  GET    /v1/opens                    （管理）按文件编号汇总：打开次数、最近打开、观看者、每页累计秒数
  GET    /v1/opens/<id>               （管理）某编号的原始事件
  DELETE /v1/opens/<id>               （管理）清空某编号的事件
存储：STATS_DB（默认 ./data/opens.json），每个编号最多保留 MAX_EVENTS_KEPT 条事件。
"""
import json
import os
import threading
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, request

DB_PATH = os.environ.get('LICENSE_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'licenses.json'))
STATS_PATH = os.environ.get('STATS_DB', os.path.join(os.path.dirname(DB_PATH), 'opens.json'))
ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
MAX_OPENS_KEPT = 200   # 每个许可保留的最近打开记录条数
MAX_EVENTS_KEPT = 2000  # 每个文件编号保留的最近统计事件条数
MAX_EVENT_BYTES = 64 * 1024  # 单条上报正文上限，超过直接丢弃

app = Flask(__name__)
_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def load_db() -> dict:
    if not os.path.exists(DB_PATH):
        return {}
    with open(DB_PATH, encoding='utf-8') as f:
        return json.load(f)


def save_db(db: dict) -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    tmp = DB_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DB_PATH)


def load_stats() -> dict:
    if not os.path.exists(STATS_PATH):
        return {}
    with open(STATS_PATH, encoding='utf-8') as f:
        return json.load(f)


def save_stats(db: dict) -> None:
    os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
    tmp = STATS_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATS_PATH)


@app.after_request
def cors(resp):
    # 文件从 file:// 打开，Origin 为 null；放开跨域
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'content-type, x-admin-token'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/v1/<path:_any>', methods=['OPTIONS'])
def preflight(_any):
    return ('', 204)


def admin_only(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not ADMIN_TOKEN or request.headers.get('X-Admin-Token') != ADMIN_TOKEN:
            return jsonify({'error': 'unauthorized'}), 401
        return fn(*a, **kw)
    return wrapper


@app.get('/healthz')
def healthz():
    return jsonify({'ok': True, 'time': now_iso()})


@app.post('/v1/key/<license_id>')
def get_key(license_id):
    body = request.get_json(silent=True) or {}
    proof = str(body.get('proof', ''))
    with _lock:
        db = load_db()
        lic = db.get(license_id)
        if not lic:
            return jsonify({'status': 'revoked'})          # 不存在的许可按吊销处理，不泄露是否存在
        opens = lic.setdefault('opens', [])
        opens.append({'at': now_iso(), 'ip': request.headers.get('X-Forwarded-For', request.remote_addr),
                      'ua': (request.headers.get('User-Agent') or '')[:120], 'ok': proof == lic.get('proof')})
        del opens[:-MAX_OPENS_KEPT]
        save_db(db)
    if proof != lic.get('proof'):
        return jsonify({'status': 'bad_proof'})
    if lic.get('status') == 'revoked':
        return jsonify({'status': 'revoked'})
    expires = lic.get('expires')
    if expires and now_iso()[:10] > expires[:10]:
        return jsonify({'status': 'expired', 'expires': expires})
    return jsonify({'status': 'active', 'secret': lic['secret'], 'checkedAt': now_iso(),
                    'maxOfflineDays': int(lic.get('maxOfflineDays', 7)), 'expires': expires})


def _clip(v, n=200):
    return str(v)[:n] if v is not None else ''


@app.post('/v1/open')
def record_open():
    # 客户端用 sendBeacon / no-cors fetch 发 text/plain，正文才是 JSON；不看 Content-Type
    raw = request.get_data(cache=False, as_text=True) or ''
    if len(raw) > MAX_EVENT_BYTES:
        return ('', 204)
    try:
        ev = json.loads(raw)
    except ValueError:
        return ('', 204)
    if not isinstance(ev, dict) or ev.get('t') not in ('open', 'pages') or not ev.get('id'):
        return ('', 204)
    rec = {'t': ev['t'], 'at': _clip(ev.get('at'), 40), 'recvAt': now_iso(), 'docId': _clip(ev.get('docId'), 80),
           'viewer': _clip(ev.get('viewer'), 40), 'ip': request.headers.get('X-Forwarded-For', request.remote_addr)}
    if ev['t'] == 'open':
        rec.update({'title': _clip(ev.get('title'), 120), 'holder': _clip(ev.get('holder'), 80), 'via': _clip(ev.get('via'), 10),
                    'ua': _clip(ev.get('ua'), 160), 'tz': _clip(ev.get('tz'), 40), 'lang': _clip(ev.get('lang'), 16),
                    'screen': _clip(ev.get('screen'), 16)})
    else:
        pages = ev.get('pages') if isinstance(ev.get('pages'), list) else []
        rec['pages'] = [{'idx': int(p.get('idx', -1)), 'name': _clip(p.get('name'), 40), 'sec': round(float(p.get('sec', 0)), 1)}
                        for p in pages[:500] if isinstance(p, dict)]
        rec['total'] = round(float(ev.get('total', 0) or 0), 1)
        rec['last'] = int(ev.get('last', -1) or -1)
    fid = _clip(ev['id'], 80)
    with _lock:
        db = load_stats()
        entry = db.setdefault(fid, {'firstAt': now_iso(), 'events': []})
        entry['events'].append(rec)
        del entry['events'][:-MAX_EVENTS_KEPT]
        save_stats(db)
    return ('', 204)


def _summarize(fid: str, entry: dict) -> dict:
    # 一个编号：打开次数、最近一次、观看者、打开方式、每页累计停留
    opens = [e for e in entry['events'] if e['t'] == 'open']
    pages_ev = [e for e in entry['events'] if e['t'] == 'pages']
    dwell = {}
    for e in pages_ev:
        for p in e.get('pages', []):
            d = dwell.setdefault(p['idx'], {'idx': p['idx'], 'name': p['name'], 'sec': 0.0})
            d['sec'] = round(d['sec'] + p['sec'], 1)
    return {'id': fid, 'holder': next((o['holder'] for o in reversed(opens) if o.get('holder')), ''),
            'title': next((o['title'] for o in reversed(opens) if o.get('title')), ''),
            'openCount': len(opens), 'firstAt': entry.get('firstAt'), 'lastOpen': opens[-1] if opens else None,
            'viewers': sorted({o['viewer'] for o in opens if o.get('viewer')}),
            'via': sorted({o['via'] for o in opens if o.get('via')}),
            'watchSec': round(sum(e.get('total', 0) for e in pages_ev), 1),
            'pages': sorted(dwell.values(), key=lambda d: d['idx'])}


@app.get('/v1/opens')
@admin_only
def list_opens():
    with _lock:
        db = load_stats()
    return jsonify({fid: _summarize(fid, entry) for fid, entry in db.items()})


@app.get('/v1/opens/<fid>')
@admin_only
def file_opens(fid):
    with _lock:
        db = load_stats()
    entry = db.get(fid)
    if not entry:
        return jsonify({'error': 'not found'}), 404
    return jsonify(entry['events'])


@app.delete('/v1/opens/<fid>')
@admin_only
def delete_opens(fid):
    # 清掉一个编号的全部事件（测试污染、重发文件后归零）
    with _lock:
        db = load_stats()
        if fid not in db:
            return jsonify({'error': 'not found'}), 404
        del db[fid]
        save_stats(db)
    return jsonify({'ok': True, 'id': fid})


@app.get('/v1/licenses')
@admin_only
def list_licenses():
    with _lock:
        db = load_db()
    out = {}
    for k, v in db.items():
        v = dict(v); v.pop('secret', None); v.pop('proof', None)
        v['openCount'] = len(v.get('opens', []))
        v['lastOpen'] = v['opens'][-1] if v.get('opens') else None
        v.pop('opens', None)
        out[k] = v
    return jsonify(out)


@app.get('/v1/licenses/<license_id>/opens')
@admin_only
def license_opens(license_id):
    with _lock:
        db = load_db()
    lic = db.get(license_id)
    if not lic:
        return jsonify({'error': 'not found'}), 404
    return jsonify(lic.get('opens', []))


@app.put('/v1/licenses/<license_id>')
@admin_only
def upsert_license(license_id):
    body = request.get_json(silent=True) or {}
    required = ['holder', 'proof', 'secret']
    if any(k not in body for k in required):
        return jsonify({'error': f'missing {required}'}), 400
    with _lock:
        db = load_db()
        lic = db.get(license_id, {'createdAt': now_iso(), 'status': 'active', 'opens': []})
        lic.update({'holder': body['holder'], 'proof': body['proof'], 'secret': body['secret'],
                    'expires': body.get('expires'), 'maxOfflineDays': int(body.get('maxOfflineDays', 7)),
                    'note': body.get('note', ''), 'updatedAt': now_iso()})
        if 'status' in body:
            lic['status'] = body['status']
        db[license_id] = lic
        save_db(db)
    return jsonify({'ok': True, 'id': license_id})


@app.post('/v1/licenses/<license_id>/revoke')
@admin_only
def revoke(license_id):
    return _set_status(license_id, 'revoked')


@app.post('/v1/licenses/<license_id>/restore')
@admin_only
def restore(license_id):
    return _set_status(license_id, 'active')


def _set_status(license_id, status):
    with _lock:
        db = load_db()
        if license_id not in db:
            return jsonify({'error': 'not found'}), 404
        db[license_id]['status'] = status
        db[license_id]['updatedAt'] = now_iso()
        save_db(db)
    return jsonify({'ok': True, 'id': license_id, 'status': status})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', '5197')))
