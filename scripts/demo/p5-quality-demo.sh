#!/usr/bin/env sh
set -eu
node packages/cli/bin/sloom.js index examples/skills
node packages/cli/bin/sloom.js eval evals/development-flow.json
node packages/cli/bin/sloom.js plan --task "修复资源列表搜索为空时报错" --blueprint bugfix --out .sloom/plans/demo-bugfix.json
node packages/cli/bin/sloom.js graph .sloom/plans/demo-bugfix.json
node packages/cli/bin/sloom.js run .sloom/plans/demo-bugfix.json --executor auto --max-nodes 2
