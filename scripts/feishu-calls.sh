#!/usr/bin/env bash
# 飞书 API 调用量：按天读出累计和分项。
#
# 数据来自运行库里的 feishu-calls:<本地日期> 记录（src/sources/feishu-loops.ts 每轮写入），
# 所以重启不会丢；服务没跑的日子不会有记录，脚本也就不列。
#
# 用法：
#   scripts/feishu-calls.sh              最近 7 天
#   scripts/feishu-calls.sh -n 30        最近 30 天
#   scripts/feishu-calls.sh --json       机器可读
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DB=${FEISHU_CALLS_DB:-$HOME/.dsh/state/superagent/orchestrator.sqlite}
DAYS=7
JSON=0

while (( $# )); do
  case "$1" in
    -n|--days) DAYS=${2:?需要一个天数}; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ -f $DB ]] || { echo "找不到运行库：$DB" >&2; exit 1; }

python3 - "$DB" "$DAYS" "$JSON" <<'PY'
import datetime, json, sqlite3, sys

db, days, as_json = sys.argv[1], int(sys.argv[2]), sys.argv[3] == '1'
# 今天还在跑，按它折算会把日用量严重低估，所以预测只用已经过完的日子。
today = datetime.date.today().isoformat()
# 只读打开：服务在跑的时候不能锁库。
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
rows = con.execute("select key, value from kv where key like 'feishu-calls:%' order by key").fetchall()
con.close()

records = []
for key, value in rows:
    try:
        day = key.split(':', 1)[1]
        data = json.loads(value)
        records.append({'day': day, 'total': int(data.get('total', 0)), 'rounds': int(data.get('rounds', 0)),
                        'byCommand': data.get('byCommand') or {}})
    except (ValueError, TypeError, json.JSONDecodeError):
        continue
records = records[-days:]

if not records:
    print('还没有记录。服务每跑完一轮就会写一条 feishu-calls:<日期>，先让它跑几分钟。')
    raise SystemExit(0)

if as_json:
    print(json.dumps(records, ensure_ascii=False, indent=1))
    raise SystemExit(0)

# 分项的名称对齐一下宽度，并把总量和轮次放到表头行。
names = sorted({name for record in records for name in record['byCommand']})
width = max([len(name) for name in names] + [8])
totals = {name: sum(record['byCommand'].get(name, 0) for record in records) for name in names}

print(f"{'日期':<12}{'调用':>8}{'轮次':>8}{'每轮':>8}")
for record in records:
    per = record['total'] / record['rounds'] if record['rounds'] else 0
    mark = '  (进行中)' if record['day'] == today else ''
    print(f"{record['day']:<12}{record['total']:>8}{record['rounds']:>8}{per:>8.1f}{mark}")

grand = sum(record['total'] for record in records)
span = len(records)
print(f"\n{span} 天合计 {grand} 次，平均 {grand / span:.0f} 次/天")

if names:
    print(f"\n{'按子命令':<{width}}{'次数':>8}{'占比':>8}")
    for name in sorted(totals, key=lambda item: -totals[item]):
        share = totals[name] / grand * 100 if grand else 0
        print(f"{name:<{width}}{totals[name]:>8}{share:>7.1f}%")

# 每月额度是 100 万次；预测只按已经过完的日子，今天还没跑完。
done = [record for record in records if record['day'] != today]
if done:
    average = sum(record['total'] for record in done) / len(done)
    monthly = average * 30
    print(f"\n按 {len(done)} 个完整日子的均值 {average:.0f} 次/天 折算：每月约 {monthly / 10000:.1f} 万次"
          f"（免费额度 100 万/月，占 {monthly / 10000:.0f}%），100 万次可用 {1000000 / average:.0f} 天")
else:
    print("\n还没有走完一整天，先不折算月用量；等明天再看。")
PY
