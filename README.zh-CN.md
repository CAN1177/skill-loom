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
- `SKILL.md` + `skillforge.json` 本地索引器
- Catalog linter
- 带 Pack 过滤的 lexical router
- bugfix / feature Blueprints
- Artifact DAG planner
- Plan validator
- Mermaid graph 输出
- dry-run trace writer
- 示例 Skills、Pack、Blueprint 和 WorkflowPlan

后续计划包括 SQLite/FTS、LLM rerank、Claude Code/Codex 真实执行、worktree 隔离和 CAO adapter。

## 快速开始

```bash
# Node.js 22+
node packages/cli/bin/sloom.js --help

# 初始化本地状态
node packages/cli/bin/sloom.js init

# 索引示例 Skills
node packages/cli/bin/sloom.js index examples/skills

# 查看 Catalog
node packages/cli/bin/sloom.js skills list
node packages/cli/bin/sloom.js skills lint

# 路由一个任务
node packages/cli/bin/sloom.js route "修复资源列表搜索为空时报错" --json

# 生成计划
node packages/cli/bin/sloom.js plan --task "修复资源列表搜索为空时报错" --blueprint bugfix --out .sloom/plans/search-empty-bug.json

# 校验、画图、dry-run
node packages/cli/bin/sloom.js validate .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js graph .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --dry-run
```

如果作为 npm package 安装，二进制命令名是 `sloom` 和 `skillforge`。

## 仓库结构

```text
packages/
  core/              catalog、routing、planning、validation、graph utilities
  cli/               CLI 入口
blueprints/          bugfix、feature 等工作流骨架
packs/               面向场景的 Skill 集合和路由策略
schemas/             sidecar 和 plan 的 JSON Schemas
examples/            示例 Skills 和 Plans
docs/                架构说明和路线图
```

## Skill sidecar

sLoom 不要求重写已有 `SKILL.md`。只需要在每个 Skill 旁边增加一个 sidecar 文件：

```text
my-skill/
  SKILL.md
  skillforge.json
```

一个最小 sidecar 示例：

```json
{
  "apiVersion": "sloom.dev/v1alpha1",
  "kind": "Skill",
  "metadata": {
    "id": "implementation.targeted-fix",
    "version": "1.0.0",
    "title": "Targeted Fix Implementation",
    "skillPath": "examples/skills/targeted-fix"
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

sidecar 描述的是：这个 Skill 适合什么任务、需要什么输入、会产出什么 Artifact、应该用哪个执行器、有哪些权限边界和质量门。

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
- 支持 plans 和 sidecars 的 YAML round-trip
- 实现带 command policy checks 的 Shell executor
- 增加 Claude Code executor adapter
- 增加 git worktree 隔离和可恢复 run state
- 建立 routing / planning eval datasets

## License

MIT
