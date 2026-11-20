#!/usr/bin/env python3
"""Private operational journal; JSON input is supplied on stdin."""
import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

KEYS = {'host', 'account_class', 'task_class', 'environment'}
NORM_KEYS = {'account_class', 'task_class', 'environment'}
FIELDS = KEYS | {'method', 'outcome', 'verification', 'failure', 'recipe', 'seconds', 'calls', 'interruptions'}
LABEL = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,79}$')
HOST = re.compile(r'^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$')


def normalize_label(value):
    return re.sub(r'[\s_]+', '-', value.strip().lower()).strip('-')


def normalize_key(host, account, task, environment):
    return (
        host.strip().lower(),
        normalize_label(account),
        normalize_label(task),
        normalize_label(environment),
    )


def validate(d, action):
    if not isinstance(d, dict) or set(d) - (FIELDS if action == 'finish' else KEYS):
        raise ValueError('invalid fields')
    if not KEYS <= d.keys():
        raise ValueError('host, account_class, task_class and environment are required')
    out = dict(d)
    for k in KEYS | ({'method', 'outcome', 'verification', 'failure', 'recipe'} & d.keys()):
        v = d[k]
        if not isinstance(v, str) or not (HOST.fullmatch(v) if k == 'host' else LABEL.fullmatch(v)):
            raise ValueError('invalid ' + k)
    for k in NORM_KEYS:
        out[k] = normalize_label(out[k])
        if not out[k]:
            raise ValueError('invalid ' + k)
    if action == 'finish':
        if not {'method', 'outcome', 'verification'} <= out.keys():
            raise ValueError('method, outcome and verification are required')
        if out['outcome'] not in ('success', 'failure', 'unknown') or out['verification'] not in ('passed', 'failed', 'unknown'):
            raise ValueError('invalid outcome or verification')
        if out['outcome'] != 'success' and 'failure' not in out:
            raise ValueError('failure category required')
        if 'recipe' in out and (out['outcome'], out['verification']) != ('success', 'passed'):
            raise ValueError('recipe requires verified success')
        for k in ('seconds', 'calls', 'interruptions'):
            if k in out and (isinstance(out[k], bool) or not isinstance(out[k], (int, float)) or not 0 <= out[k] < 10000000 or (k != 'seconds' and not isinstance(out[k], int))):
                raise ValueError('invalid ' + k)
    return out


def recommend(db, key):
    host = key[0]
    rows = db.execute(
        'SELECT id,created,host,account,task,environment,kind,data FROM events WHERE lower(host)=? ORDER BY id DESC LIMIT 200',
        (host,),
    ).fetchall()

    recent = []
    recipe = None
    blocked = False
    related_recipes = []
    related_failures = []
    other_state = {}

    for ident, created, r_host, r_account, r_task, r_env, kind, data in rows:
        item = json.loads(data)
        r_key = normalize_key(r_host, r_account, r_task, r_env)
        if r_key == key:
            if kind == 'invalidate' or (kind == 'finish' and (item['outcome'], item['verification']) != ('success', 'passed')):
                blocked = True
            if kind == 'finish' and item['outcome'] != 'success' and len(recent) < 5:
                recent.append({'id': ident, 'created': created, **item})
            if recipe is None and not blocked and kind == 'finish' and 'recipe' in item:
                recipe = {'id': ident, 'created': created, **item}
        else:
            st = other_state.setdefault(r_key, {'blocked': False, 'picked': False})
            if kind == 'invalidate' or (kind == 'finish' and (item['outcome'], item['verification']) != ('success', 'passed')):
                st['blocked'] = True
            if kind == 'finish' and item['outcome'] != 'success' and len(related_failures) < 5:
                related_failures.append({'id': ident, 'created': created, **item})
            if not st['blocked'] and not st['picked'] and kind == 'finish' and 'recipe' in item and len(related_recipes) < 5:
                st['picked'] = True
                related_recipes.append({'id': ident, 'created': created, **item})

    return {
        'recipe': recipe,
        'recent_failures': recent,
        'related_recipes': related_recipes,
        'related_failures': related_failures,
    }


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        epilog='JSON stdin: host, account_class, task_class, environment; finish adds method, outcome, verification and optional failure, recipe, seconds, calls, interruptions. Labels only; recipe is a short semantic action, never a command.',
    )
    p.add_argument('action', choices=['recommend', 'finish', 'invalidate'])
    p.add_argument('--state-dir', default=os.environ.get('BROWSER_LEARNING_STATE', '~/.local/state/browser-learning'))
    a = p.parse_args()
    d = validate(json.load(sys.stdin), a.action)
    os.umask(0o077)
    path = Path(a.state_dir).expanduser()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_mode & 0o077:
        raise ValueError('state directory must be private')
    db = sqlite3.connect(path / 'journal.sqlite3', timeout=30)
    db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP, host TEXT, account TEXT, task TEXT, environment TEXT, kind TEXT, data TEXT)')
    key = tuple(d[k] for k in ('host', 'account_class', 'task_class', 'environment'))
    with db:
        if a.action != 'recommend':
            db.execute('INSERT INTO events(host,account,task,environment,kind,data) VALUES (?,?,?,?,?,?)', (*key, a.action, json.dumps(d)))
        else:
            print(json.dumps(recommend(db, key)))
    db.close()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, json.JSONDecodeError, sqlite3.Error, OSError) as exc:
        print('journal error: ' + str(exc), file=sys.stderr)
        sys.exit(2)
