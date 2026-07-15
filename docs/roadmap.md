# sLoom：Skill-first Orchestrator CLI 开发计划

> 目标：将本地大量研发全流程 Skill 转为可索引、可检索、可解释选择、可审查编排、可确定性执行、可追溯评估的工程系统。

## 1. 产品定位

项目名：`sLoom`；CLI / npm 包名建议使用全小写的 `sloom`。

含义：`Skill Loom`，将离散的研发 Skills 按依赖、阶段、权限和质量门“编织”为可执行工作流。

```text
任务 / Issue
  -> Skill Catalog
  -> Router
  -> Planner
  -> Validator
  -> Workflow DAG
  -> Deterministic Executor
       ├─ Claude Code
       ├─ Codex CLI
       ├─ Shell
       └─ CAO（可选）
  -> Artifacts + Gates + Trace + Eval
```

**核心原则：Skill 是第一抽象；Agent 与 CLI 只是执行 Skill 的运行时。**

| 组件 | 责任 |
|---|---|
| Skill | 可复用能力单元，例如需求分析、代码实现、测试、Review |
| Pack | 某类研发场景的一组 Skill、路由规则与策略 |
| Blueprint | feature、bugfix、refactor 等流程的阶段、产物和门禁骨架 |
| Router | 根据任务与仓库上下文召回、筛选候选 Skill |
| Planner | 将候选 Skill 组装为最小、可验证的 Artifact DAG |
| Executor | 调用 Claude Code、Codex、Shell 或 CAO 执行 DAG 节点 |
| Artifact | 节点间传递的可落盘、可验证、可审计产物 |
| Policy | 权限、风险、审批、命令限制和质量门规则 |

## 2. 参考项目与取舍

### 2.1 skill-orchestration-system

仓库：<https://github.com/Rainnystone/skill-orchestration-system>

其公开定位是一个 **skill-first CLI**，用于将 Agent Skills 转为可审查、适合路由的 packs。应重点借鉴：

- Skill-first 的对象模型：先治理和组合 Skill，而非先创建大量 Agent
- Pack 的组织方式：将技能、路由规则、适用边界与策略按领域归组
- 可审查路由：计划应可落盘、可 diff、可人工批准
- Skill 元数据与路由友好描述的设计

不要假设它已具备完整 DAG 执行、Artifact Store 或失败恢复；先将其作为 **Catalog / Pack / Router 设计参考**。

### 2.2 Stack Forge

仓库：<https://github.com/smartchaos/stack-forge>

将其作为 **研发流程 Blueprint 与交付标准** 的参考，重点拆解：

- feature、bugfix、refactor、incident、release 等工作流模板
- 阶段划分：discovery、design、implementation、verification、review、release
- 每个阶段的必要 Artifact、质量门与人工审批点
- 从需求到交付的目录、命名、可追溯性约定

不要将阶段和具体 Skill 绑定。Blueprint 只表达“本阶段必须产出什么、何时必须审批”；Planner 再从 Catalog 中动态选择哪个 Skill 满足该目标。

### 2.3 CLI Agent Orchestrator（CAO）

仓库：<https://github.com/awslabs/cli-agent-orchestrator>

CAO 是 **多 coding-CLI Agent 的执行 runtime**，不是你工具的核心 Planner。应借鉴或通过 Adapter 使用：

- Claude Code、Codex CLI、Gemini 等多 provider 的适配思路
- Supervisor/Worker 的分工、session 生命周期与进程隔离
- tmux / terminal 可接管的长任务运行体验
- 需要并行、跨模型或长上下文时的 Worker 调度

不要让 CAO 的 Supervisor 决定最终 Skill 选择。`sloom` 必须先冻结并验证 DAG，再把单个节点下发给 CAO Worker。

### 2.4 最终组合

```text
Stack Forge
  └─ 参考：研发阶段、Artifact、质量门、Blueprint

skill-orchestration-system
  └─ 参考：Skill Catalog、Pack、路由与审查模型

sLoom（自研核心）
  └─ 实现：索引、检索、规划、DAG 校验、Artifact、Policy、Trace

CAO（可选执行器）
  └─ 负责：多 CLI、多 Agent、并发、隔离、可接管 session
```

## 3. 核心设计原则

### 3.1 不改写现有 Skill

保留现有 `SKILL.md`，通过同目录的 `sloom.yaml` 补充编排元数据：

```text
~/.claude/skills/react-feature/
  SKILL.md
  sloom.yaml
```

### 3.2 Artifact 优先

节点间不依赖聊天历史，而传递具名、可校验的文件化产物：

```text
requirements-analysis -> requirement.spec.json
architecture-design   -> architecture.md + api-contract.yaml
implementation        -> source.diff + implementation-summary.md
testing               -> test-report.json
review                -> review-result.json
```

### 3.3 计划与执行分离

```bash
sloom route "为资源列表增加批量操作与权限控制"
sloom plan --task issue-482 --out .sloom/plans/issue-482.yaml
sloom validate .sloom/plans/issue-482.yaml
sloom run .sloom/plans/issue-482.yaml
```

Plan 一旦被批准并执行，Executor 不应让模型动态加删节点；失败必须形成显式 `replan`。

### 3.4 最小闭合 DAG

Planner 必须选择能满足任务 Artifact 依赖的最小 Skill 集，而不是对每个任务套完整研发流水线。

小型 Bugfix：

```text
repo-investigation -> bug-reproduction -> targeted-fix -> regression-test -> review
```

跨模块 Feature：

```text
repo-exploration -> requirements -> architecture
                                  -> frontend-implementation
                                  -> backend-implementation
frontend + backend -> integration-test -> review -> release-check
```

## 4. 技术方案

建议技术栈：

- Node.js 22+
- TypeScript
- pnpm workspace / monorepo
- Commander 或 oclif：CLI
- Zod：运行时 schema 与校验
- SQLite + FTS5：本地 Catalog、索引、运行记录
- sqlite-vec 或 LanceDB：可选语义检索
- YAML：Skill sidecar、Pack、Blueprint、Plan
- JSON Schema：编辑器提示、对外校验、CI
- Pino：结构化日志
- Vitest：单元与集成测试

目录建议：

```text
sloom/
  packages/
    cli/
    core/
    schema/
    retrieval/
    executor-core/
    executor-shell/
    executor-claude-code/
    executor-codex/
    executor-cao/
    evals/
  blueprints/
    feature.yaml
    bugfix.yaml
    refactor.yaml
    incident.yaml
    release.yaml
  packs/
    frontend-engineering/
    backend-engineering/
    quality-engineering/
  schemas/
  examples/
  docs/
```

## 5. Skill 元数据

`sloom.yaml` 示例：

```yaml
apiVersion: sloom.dev/v1alpha1
kind: Skill

metadata:
  id: frontend.react.feature-implementation
  version: 1.0.0
  title: React Feature Implementation
  skillPath: ~/.claude/skills/react-feature
  owners: [frontend-platform]

spec:
  intents: [feature, frontend-change, ui-change]
  capabilities: [react, typescript, hooks, tanstack-query]

  inputs:
    required: [repo.context, requirement.spec]
    optional: [api.contract, ui.design]

  outputs: [source.diff, implementation.summary, unit-test.report]

  dependencies:
    requires:
      - capability: repo.exploration
      - artifact: requirement.spec
    optional:
      - artifact: architecture.decision

  execution:
    preferredExecutor: claude-code
    fallbackExecutors: [codex]
    workspace: isolated-worktree
    timeoutMinutes: 40
    parallelSafe: false

  policy:
    risk: medium
    permissions: [filesystem.write, git.diff, shell.test]
    denyCommands: [rm -rf, git push, kubectl apply]

  routing:
    includeKeywords: [React, 页面, 组件, UI, 前端]
    excludeKeywords: [发布, 仅文档, 排障]
    cost: medium
    tags: [implementation, frontend]

  gates:
    before: [artifact:requirement.spec]
    after:
      - command: pnpm lint
      - command: pnpm test --filter web
      - artifact:unit-test.report
```

最小必备字段：

- 身份：`id`、`version`、`skillPath`
- 路由：`intents`、`capabilities`、`tags`、关键词
- 依赖：`inputs`、`outputs`、`requires`
- 执行：`preferredExecutor`、`workspace`、`timeout`
- 安全：`risk`、`permissions`、命令限制
- 质量：`gates`、产物 schema、验证命令
- 成本：`cost`、估算时长或 token 预算

## 6. Pack 与 Blueprint

### 6.1 Pack

Pack 用于限制某一场景可选 Skill 范围，降低大 Skill Catalog 的噪声：

```yaml
apiVersion: sloom.dev/v1alpha1
kind: Pack

metadata:
  id: frontend-delivery
  version: 1.0.0

spec:
  include:
    - repo.exploration
    - requirements.analysis
    - architecture.frontend
    - frontend.react.feature-implementation
    - test.unit
    - test.e2e
    - review.code

  routingPolicy:
    maxSkills: 7
    preferMinimalPlan: true
    minimumConfidence: 0.70

  policy:
    allowExecutors: [claude-code, codex, shell]
    defaultWorkspace: isolated-worktree
```

### 6.2 Blueprint

Blueprint 只规定阶段、条件、Artifact 和质量门：

```yaml
apiVersion: sloom.dev/v1alpha1
kind: Blueprint

metadata:
  id: feature
  version: 1.0.0

spec:
  intent: feature

  phases:
    - id: discovery
      requiredArtifacts: [repo.context, requirement.spec]

    - id: design
      condition: "task.risk in ['medium', 'high'] || task.scope == 'cross-module'"
      requiredArtifacts: [architecture.decision]

    - id: implementation
      requiredArtifacts: [source.diff, implementation.summary]

    - id: verification
      requiredArtifacts: [test-report]

    - id: review
      requiredArtifacts: [review-result]
      gate: "review-result.status == 'approved'"
```

## 7. Router 设计

路由使用四层机制：

1. **硬策略过滤**：根据仓库、Pack、权限、风险、禁用项移除不可用 Skill
2. **混合召回**：BM25/FTS + embedding，获取 Top-K 候选
3. **LLM Rerank**：只向模型提供候选的紧凑 metadata，生成选择理由和计划草案
4. **静态校验**：检查 Artifact 依赖、冲突、预算、权限和并行安全

命令：

```bash
sloom route   --task "为云资源列表加入批量标签编辑，并按 RBAC 控制权限"   --repo .   --pack frontend-delivery   --json
```

输出必须包括：

- 意图、复杂度、风险等级
- Top-K 候选 Skill 与分数
- 每项选中理由
- 排除 Skill 与排除理由
- 建议 Blueprint
- 预估成本与需要人工审批的位置

## 8. Planner 与计划格式

Planner 将任务、候选 Skill、Blueprint 和现有 Artifact 转为可审查 DAG。

```yaml
apiVersion: sloom.dev/v1alpha1
kind: WorkflowPlan

metadata:
  id: issue-482
  blueprint: feature

spec:
  nodes:
    - id: explore
      skill: repo.exploration
      executor: claude-code
      outputs: [repo.context]
      selectedBecause: "Repository context is absent"

    - id: requirements
      skill: requirements.analysis
      dependsOn: [explore]
      inputs: [repo.context]
      outputs: [requirement.spec]

    - id: architecture
      skill: architecture.frontend
      dependsOn: [requirements]
      when: "task.risk == 'medium'"
      outputs: [architecture.decision, api.contract]

    - id: implement-ui
      skill: frontend.react.feature-implementation
      dependsOn: [requirements, architecture]
      workspace: worktree:issue-482-ui
      outputs: [source.diff, unit-test.report]

    - id: verify
      skill: test.integration
      dependsOn: [implement-ui]
      outputs: [test-report]

    - id: review
      skill: review.code
      dependsOn: [verify]
      outputs: [review-result]

  gates:
    - after: architecture
      type: approval
      requiredWhen: "task.risk != 'low'"

    - after: review
      type: assertion
      expression: "artifacts.review-result.status == 'approved'"
```

Planner 验证项：

- 输入 Artifact 是否能由初始上下文或前置节点提供
- 是否存在循环依赖
- 是否存在互斥或越权 Skill
- 质量门是否满足
- 并行节点是否 `parallelSafe` 且使用独立 worktree
- Skill 版本、hash、执行器、模型是否锁定
- 是否满足 cost/time budget

## 9. 执行器设计

统一接口：

```ts
export interface SkillExecutor {
  readonly name: string;
  canExecute(node: PlannedNode): boolean;
  execute(input: {
    node: PlannedNode;
    artifacts: ArtifactManifest;
    workspace: Workspace;
    run: RunContext;
  }): Promise<ExecutionResult>;
}
```

实现优先级：

| Executor | 阶段 | 用途 |
|---|---:|---|
| `shell` | P0 | Git、pnpm、lint、test、build、脚本 |
| `claude-code` | P0 | 调用主力 Skill 资产 |
| `codex` | P1 | fallback、独立审查、交叉验证 |
| `cao` | P2 | 多 Agent 并行、跨 provider、长任务 |
| `docker` | P2 | 不可信或高风险执行隔离 |

CAO 接入原则：仅将**已冻结的 Plan 节点**交给 CAO。CAO 可负责 session、worker、tmux、跨 provider 和并发；Skill 选择与 Artifact DAG 一律由 `sloom` 决定。

## 10. Artifact Store 与 Trace

```text
.sloom/
  catalog.db
  plans/
    issue-482.yaml
  runs/
    20260715-104500-issue-482/
      manifest.json
      plan.lock.yaml
      events.jsonl
      artifacts/
        repo.context.json
        requirement.spec.md
        architecture.decision.md
        api.contract.yaml
        test-report.json
        review-result.json
      logs/
        explore.log
        requirements.log
        implement-ui.log
```

`plan.lock.yaml` 至少锁定：

- Skill ID、版本、内容 hash
- Executor、provider、模型版本
- 输入 Artifact hash
- Policy 版本
- Blueprint 与 Pack 版本

## 11. Policy 与质量门

Policy 必须是代码可执行的独立层，不能只依赖 prompt：

```yaml
apiVersion: sloom.dev/v1alpha1
kind: Policy

metadata:
  id: default-engineering-policy

spec:
  rules:
    - deny:
        action: deploy.production
        unless:
          - artifact: review-result
            expression: "status == 'approved'"
          - approval: release-manager

    - require:
        action: git.commit
        artifacts: [test-report, review-result]

    - require:
        action: filesystem.write
        workspace: isolated-worktree

    - deny:
        commandPatterns:
          - "rm -rf /"
          - "git push --force"
```

建议 hook 时机：

- Plan 生成后
- Run 开始前
- Node 开始前
- 外部命令调用前
- Artifact 写入后
- Node 完成后

## 12. CLI 命令面

```bash
# Skill 发现、治理
sloom init
sloom index [paths...]
sloom skills list
sloom skills show <id>
sloom skills lint
sloom packs list

# 路由与编排
sloom route "<task>" --repo . --pack frontend-delivery
sloom plan --task "<task>" --blueprint feature
sloom validate <plan.yaml>
sloom graph <plan.yaml> --format mermaid

# 执行与人工控制
sloom run <plan.yaml> --dry-run
sloom run <plan.yaml> --executor claude-code
sloom approve <run-id> <gate-id>
sloom reject <run-id> <gate-id> --reason "..."
sloom replan <run-id> --from <node-id>

# 追踪与评估
sloom status <run-id>
sloom trace <run-id>
sloom artifacts <run-id>
sloom eval route --dataset evals/routing.jsonl
sloom eval plan --dataset evals/planning.jsonl
```

## 13. 开发路线

### Phase 0：反向研究与 ADR

目标：明确边界，不 Fork 重型 runtime。

- 研究 skill-orchestration-system 的 Pack / manifest / 路由设计
- 研究 Stack Forge 的阶段、Artifact、质量门、工作流模板
- 研究 CAO 的 provider adapter、session 和 worker 生命周期
- 输出 ADR：Skill、Agent、Executor、Blueprint、Artifact、Policy 的边界

验收：`docs/architecture/adr-001-core-abstractions.md` 获得确认。

### Phase 1：Skill Catalog 与 Linter

目标：让所有现有 Skill 可发现、可治理。

- 扫描 `~/.claude/skills`、项目 Skill 目录、Codex/OpenCode Skill 目录
- 解析 `SKILL.md` 与 `sloom.yaml`
- 建立 SQLite Catalog 与内容 hash
- 检测重复 ID、循环依赖、缺失 Artifact 生产者、权限冲突和版本冲突
- 实现 `index`、`list`、`show`、`lint`

验收：为 10 个高频 Skill 补齐 sidecar 后，`sloom skills lint --strict` 可通过。

### Phase 2：Router 与评估集

目标：稳定从大量 Skill 中召回少量候选。

- FTS/BM25 检索
- 可选 embedding 与 rerank
- Pack / policy 过滤
- 输出选中与排除理由
- 手工标注 30 至 50 个真实研发任务作为 routing eval 集

验收：Top-5 Recall、候选数量、误选率可通过 `sloom eval route` 持续跟踪。

### Phase 3：Blueprint Planner 与 DAG Validator

目标：生成最小闭合、可审查的计划。

- 实现 `bugfix.yaml` 与 `feature.yaml`
- 建立 Artifact 依赖闭包算法
- 使用 LLM 生成候选选择和计划草案，所有输出必须通过 schema
- 实现循环、缺失输入、互斥、权限、预算、并发安全校验
- 输出 YAML、JSON、Mermaid

验收：小 bug 不会错误加入架构/发布节点；跨模块 feature 会自动补齐需求、设计、验证和 review。

### Phase 4：确定性执行与 Artifact Store

目标：单 Agent 完整闭环。

- 先实现 Shell 与 Claude Code executor
- DAG scheduler：依赖、条件、并发、重试、暂停、恢复
- Git worktree 隔离写操作
- Artifact schema 校验、日志与事件记录
- 审批 gate 与 `replan`

验收：可以从任意失败节点恢复，且不会重跑已成功且 Artifact 仍有效的节点。

### Phase 5：Codex 与 CAO Adapter

目标：仅在必要处引入多模型与多 Agent。

- Codex：fallback、独立 review、交叉验证
- CAO：将已规划节点运行成独立 worker/session
- 并发条件：节点 `parallelSafe: true`、独立 worktree、无共享资源锁
- 将 CAO session ID 回写到 Run Trace

验收：前后端任务可以在独立 worktree 并行，后续汇合至 integration test 与 review。

### Phase 6：策略、评估与产品化

目标：让路由质量可以持续优化。

- Plan/routing golden dataset
- 运行数据分析：选用率、失败率、耗时、Artifact 合格率
- 人工反馈：accepted、rejected、manual-add、manual-remove
- Policy bundles：默认、严格生产、只读分析、快速修复
- CI 验证与可选 TUI

## 14. MVP 范围

MVP 不做：Web UI、swarm、动态组织、复杂分布式调度。

MVP 必须具备：

1. Skill Indexer
2. Sidecar metadata
3. Catalog Linter
4. FTS 路由
5. Bugfix / Feature Blueprint
6. Artifact DAG 生成与校验
7. Claude Code + Shell 执行器
8. Worktree 隔离
9. Artifact Store / Trace
10. 手工审批 gate

## 15. 第一周执行清单

1. 建立 pnpm TypeScript monorepo
2. 定义 Zod：`SkillManifest`、`Pack`、`Blueprint`、`WorkflowPlan`、`Artifact`
3. 实现 `sloom init`
4. 实现 `sloom index ~/.claude/skills ./skills`
5. 实现 `skills list/show/lint`
6. 为 10 个最高频研发 Skill 添加 `sloom.yaml`
7. 写一个 `blueprints/bugfix.yaml`
8. 实现静态依赖闭包：根据 `requires / inputs / outputs` 补齐节点
9. 实现 `sloom plan --no-llm`，输出 YAML 和 Mermaid
10. 为 10 个真实 bugfix 任务人工检查计划质量并记录问题

第一周结束时，应已验证最关键的假设：**你的现有 Skill 能否被稳定地描述为可组合的 Artifact producer/consumer，而不是只能被大模型临场调用的 prompt 集合。**

## 16. 成功指标

- Skill 覆盖率：具有完整 sidecar metadata 的 Skill 占比
- 路由召回：真实任务中，人工认可 Skill 是否出现在 Top-K
- 计划最小性：每个任务不必要节点数
- Plan 有效性：首次校验通过率
- Artifact 合格率：输出满足 schema / gate 的比例
- 重规划率：失败后需要补充或替换 Skill 的比例
- 人工干预率：按任务类型和风险等级分层统计
- 执行成本：每个 workflow 的时长、token、CLI 调用量

## 17. 最终决策

采用以下分层：

```text
sLoom 核心
  = Skill Catalog + Pack + Router + Blueprint Planner
  + Artifact DAG Validator + Policy + Trace

执行层
  = Claude Code / Shell（MVP）
  + Codex（P1）
  + CAO（P2，多 Agent 和跨模型时启用）

参考来源
  = skill-orchestration-system 的 skill-first / pack 思路
  + Stack Forge 的全流程 Blueprint / 质量门思路
  + CAO 的多 CLI provider / worker session 适配思路
```

不要把“Skill 选择”外包给多 Agent Supervisor；先让 Skill 目录、Artifact 契约、Plan 和 Policy 变得可验证。多 Agent 只是一种执行优化，而不是编排系统的核心。
