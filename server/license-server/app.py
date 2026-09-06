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
"""
import json
import os
import threading
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, request

DB_PATH = os.environ.get('LICENSE_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'licenses.json'))
ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
MAX_OPENS_KEPT = 200   # 每个许可保留的最近打开记录条数

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


@app.after_request
def cors(resp):
    # 文件从 file:// 打开，Origin 为 null；放开跨域
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'content-type, x-admin-token'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS'
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
