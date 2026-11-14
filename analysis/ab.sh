#!/bin/zsh
# Usage: ab.sh <level> <seeds> "<flags A>" "<flags B>"  -- runs both configs in parallel (4 seeds each max)
cd /Users/vuhoangphuoc/bahn-express/typescript
eval "bun dispatch.ts --level $1 --seeds $2 $3" > /tmp/ab_a.txt 2>&1 &
eval "bun dispatch.ts --level $1 --seeds $2 $4" > /tmp/ab_b.txt 2>&1
wait
echo "== A: $3"; grep -v Rebuilding /tmp/ab_a.txt
echo "== B: $4"; grep -v Rebuilding /tmp/ab_b.txt
