# sLoom

**sLoom**（`sloom`）是一个**开源**的 Skill-first Orchestrator CLI，用来把分散的工程 `SKILL.md` 文件编织成可路由、可审查、可执行的研发工作流。

[English README](README.md)

它的核心思路很简单：

> **Skill 是第一抽象。** Claude Code、Codex、Shell、多 Agent runtime 都只是执行后端，不应该成为工作流策略本身。

```text
任务 / Issue
  -> Skill Catalog
  -> Router
  -> Blueprint Planner
  -> DAG Validator
  -> Deterministic Executor
  -> Artifacts + Gates + Trace
```

## 为什么做 sLoom？

很多团队已经沉淀了大量好用的研发 Skills：需求分析、仓库探索、实现、测试、Review、发布检查等。但这些 Skills 往往分散在不同目录、不同工具和不同使用习惯里。

对于一个简单开发任务，我们仍然需要人工判断：

- 先做仓库探索，还是先澄清需求？
- 什么情况下需要设计评审？
- 实现、测试、Review 应该分别由哪个 Skill 完成？
- 节点之间靠什么交接？聊天历史，还是可验证产物？
- 哪些步骤需要审批，哪些命令应该禁止？

sLoom 的目标不是再造一个“大而全 Agent”，而是把这些已有 Skills 治理起来，让它们可以被稳定选择、组合和执行。

## 当前状态

这个仓库目前是第一个开源 MVP scaffold，已经包含：

- 零依赖 Node.js 22 CLI
- `SKILL.md` + 非侵入式 metadata overlay 本地索引器
- Catalog linter
- 带 Pack 过滤的 lexical router
- bugfix / feature Blueprints
- Artifact DAG planner
- Plan validator
- Mermaid graph 输出
- dry-run trace writer
- 可恢复的 Workflow Artifact Runtime
- safe shell executor 和 agent handoff runtime
- Codex / Claude Code / CAO dispatch packages
- 示例 Skills、Pack、Blueprint 和 WorkflowPlan

SQLite/FTS、LLM rerank、显式 opt-in 的真实子进程执行、worktree 隔离、更完整的 CAO log 回收和 Gate 强制执行是后续里程碑。

## 快速开始

```bash
# Node.js 22+
node packages/cli/bin/sloom.js --help

# 初始化本地状态
node packages/cli/bin/sloom.js init

# 只读扫描示例 Skills，生成非侵入式 inventory
node packages/cli/bin/sloom.js scan examples/skills

# 生成缺失 overlay 的建议，不修改原始 Skill 目录
node packages/cli/bin/sloom.js propose --from .sloom/inventory.json

# Review 后把 overlay 写入 .sloom/overlays，并生成可回滚备份
node packages/cli/bin/sloom.js apply .sloom/proposals/overlays.json --yes --backup
# node packages/cli/bin/sloom.js rollback <backup-id>

# 使用 Pack overlays 索引示例 Skills
node packages/cli/bin/sloom.js index examples/skills

# 查看 Catalog
node packages/cli/bin/sloom.js skills list
node packages/cli/bin/sloom.js skills lint

# 路由一个任务
node packages/cli/bin/sloom.js route "修复资源列表搜索为空时报错" --json

# 生成计划
node packages/cli/bin/sloom.js plan --task "修复资源列表搜索为空时报错" --blueprint bugfix --out .sloom/plans/search-empty-bug.json

# 校验、画图、dry-run，并使用 Artifact Runtime 执行
node packages/cli/bin/sloom.js validate .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js graph .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --dry-run
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js runs
# P3：使用真实 safe-shell + agent handoff adapter
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor auto
# node packages/cli/bin/sloom.js artifact put <run-id> <node-id> <artifact-name> <file>
# node packages/cli/bin/sloom.js resume <run-id> --executor auto
```

如果作为 npm package 安装，二进制命令名是 `sloom`。

## Workflow 执行与 Artifact

`sloom run` 会在 `.sloom/runs/<run-id>` 下创建可恢复的运行目录：

```text
.sloom/runs/<run-id>/
  plan.lock.json
  run-state.json
  events.jsonl
  artifacts/
    manifest.json
    <node-id>/<artifact-name>.md
```


P3/P4 run 目录还可能包含 agent handoff 和 dispatch package：

```text
.sloom/runs/<run-id>/
  handoffs/<node-id>/
    task.md
    inputs.json
    expected-outputs.json
  dispatches/<node-id>/<adapter>/
    prompt.md
    dispatch.json
    status.json
    launch-cao.sh        # 仅 CAO
```

这让 sLoom 现在就能在 Claude CLI 或 Codex CLI 中使用：sLoom 负责 routing、plan lock、policy、state、events 和 artifacts；外层 Agent 执行 handoff task，并把结果提交回运行时。更多说明见 [Agent Integration](docs/agent-integration.md) 和可选的 [sLoom Entry Skill](skills/sloom-orchestrator/SKILL.md)。

当前默认 local runtime 是确定性、安全的：不会修改源码，只会把每个节点的输出物化为可追踪 Artifact，便于检查和恢复。

P3 增加了显式 Executor Adapter 模式。`--executor auto` 会对 policy 允许的 shell 节点执行小范围 safe-command allowlist；对 Codex / Claude Code 节点则生成可持久化的 handoff package，而不是偷偷启动 Agent 或直接改源码。P4 进一步提供 provider dispatch package：`--executor codex`、`--executor claude-code`、`--executor cao` 会生成可审计的 prompt/spec，其中 CAO 的 `allowedTools` 会从 sLoom policy 映射而来。真实 Agent 完成任务后写出 Markdown Artifact，通过 `sloom artifact put` 回填，再用 `sloom resume --executor auto|cao` 继续 DAG。

常用命令：

```bash
node packages/cli/bin/sloom.js executors
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --max-nodes 2
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor auto
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor cao
sh .sloom/runs/<run-id>/dispatches/<node-id>/cao/launch-cao.sh
node packages/cli/bin/sloom.js artifact put <run-id> analysis requirement.spec ./requirement.spec.md --executor cao
node packages/cli/bin/sloom.js resume <run-id> --executor cao
node packages/cli/bin/sloom.js runs --json
```


## 仓库结构

```text
packages/
  core/              catalog、routing、planning、validation、graph utilities
  cli/               CLI 入口
blueprints/          bugfix、feature 等工作流骨架
packs/               面向场景的 Skill 集合和路由策略
schemas/             metadata overlay 和 plan 的 JSON Schemas
examples/            示例 Skills 和 Plans
docs/                架构说明、Agent 集成说明和路线图
skills/              可选的 sLoom Entry Skill，用于 Agent 自然语言调用
```

## Skill metadata overlay

sLoom 默认不应该修改你已有的本地 Skill。`scan -> propose -> apply --backup` 让每一次元数据变更都可审查、可回滚。`SKILL.md` 目录应被视为只读资产，编排元数据放在 sLoom 工作区或 Pack 中：

```text
# 已存在的 Skill，只读
~/.claude/skills/my-skill/
  SKILL.md

# sLoom 管理的项目级编排元数据
.sloom/overlays/skills/implementation.targeted-fix.json

# 或团队/开源共享 Pack 中的 overlay
packs/frontend-delivery/skills/implementation.targeted-fix.json
```

同目录 `sloom.json` 仍然可以支持，但它只适合 Skill 作者主动随 Skill 发布便携元数据的场景；不应该作为治理既有本地 Skill 的默认方式。

一个最小 overlay 示例：

```json
{
  "apiVersion": "sloom.dev/v1alpha1",
  "kind": "SkillOverlay",
  "metadata": {
    "id": "implementation.targeted-fix",
    "version": "1.0.0",
    "title": "Targeted Fix Implementation",
    "source": {
      "type": "local-skill",
      "path": "examples/skills/targeted-fix",
      "fingerprint": "sha256:..."
    }
  },
  "spec": {
    "intents": ["bugfix", "feature"],
    "capabilities": ["implementation", "small-change"],
    "inputs": { "required": ["repo.context"], "optional": ["requirement.spec"] },
    "outputs": ["source.diff", "implementation.summary"],
    "execution": { "preferredExecutor": "claude-code", "workspace": "isolated-worktree", "timeoutMinutes": 40 },
    "policy": { "risk": "medium", "permissions": ["filesystem.write", "git.diff"], "denyCommands": ["rm -rf", "git push"] },
    "routing": { "includeKeywords": ["修复", "bug", "实现"], "tags": ["implementation"] }
  }
}
```

overlay 描述的是：这个 Skill 适合什么任务、需要什么输入、会产出什么 Artifact、应该用哪个执行器、有哪些权限边界和质量门。

## 设计原则

1. **Artifact-first**：节点之间传递具名 Artifact，而不是隐藏的聊天历史。
2. **Plan before run**：先冻结并校验 DAG，再执行。
3. **Minimal closed DAG**：只选择满足 Artifact 依赖所需的最小 Skill 集合。
4. **Policy as code**：权限、命令 deny-list、Gate 和审批点必须能在 prompt 之外被执行和校验。
5. **Executors are adapters**：Claude Code、Codex、Shell、CAO 负责执行已规划节点，不负责最终 Skill 选择。

## 适合谁使用？

sLoom 适合这些团队：

- 已经有一批内部 `SKILL.md`，但缺少统一治理和自动编排；
- 希望把研发流程从 prompt 经验升级为 Artifact 契约和 Workflow DAG；
- 想让 Claude Code、Codex、Shell、多 Agent runtime 各司其职；
- 不希望把 Skill 选择、质量门和权限策略完全交给某个 Supervisor 临场决定。

## 当前 MVP 能验证什么？

当前版本不是最终形态，但已经足够验证一个关键假设：

> 现有 Skills 是否能够被稳定描述为 Artifact producer / consumer，并自动组合成最小可执行工作流。

如果这个假设成立，后续再接入 SQLite/FTS、LLM rerank、真实 executor、worktree 隔离、失败恢复和多 Agent 并行，都会有更稳的基础。

## 架构分层

sLoom 会刻意保持分层：

```text
sLoom Core
  = Skill Catalog + Pack + Router + Blueprint Planner
  + Artifact DAG Validator + Policy + Trace

Execution Runtime
  = Shell / Claude Code / Codex / CAO
```

Skill 选择、计划生成、权限策略和质量门属于 sLoom Core；执行器只负责运行已经冻结的节点。这样做的好处是：计划可以被审查，失败可以被恢复，风险可以被控制，团队也能持续优化路由和规划质量。

## Roadmap

完整计划见 [`docs/roadmap.md`](docs/roadmap.md)。下一阶段重点：

- 用 SQLite + FTS5 替换 JSON Catalog
- 增强 schema validation
- 支持 plans 和 metadata overlays 的 YAML round-trip
- 增加 Codex、Claude Code、CAO 的显式 opt-in 子进程/会话监控
- 增加 git worktree 隔离
- 建立 routing / planning eval datasets

## License

MIT
