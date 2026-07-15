import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverlayProposal, createPlan, indexSkills, lintCatalog, listExecutorAdapters, listRuns, mapPolicyToCaoAllowedTools, proposeOverlays, readBlueprint, readRunState, resumeWorkflowRun, rollbackBackup, routeTask, runWorkflowPlan, scanSkills, submitRunArtifact, validatePlan, writeInventory } from '../src/index.js';


test('scans skills into non-invasive inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  const inventory = scanSkills(['examples/skills'], root);
  assert.equal(inventory.kind, 'SkillInventory');
  assert.equal(inventory.entries.length, 6);
  assert.ok(inventory.entries.every(entry => entry.fingerprints.skillMd.startsWith('sha256:')));
  assert.ok(inventory.entries.every(entry => entry.suggestedOverlayPath.startsWith('.sloom/overlays/skills/')));
  writeInventory(inventory, root);
  assert.equal(existsSync(join(root, '.sloom', 'inventory.json')), true);
  const proposal = proposeOverlays(inventory);
  assert.equal(proposal.kind, 'SkillOverlayProposal');
  assert.equal(proposal.changes.length, 6);
  assert.ok(proposal.changes.every(change => change.action === 'upsert-overlay'));
});


test('applies overlay proposals safely and rollbacks created files', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  const inventory = scanSkills(['examples/skills'], root);
  const proposal = proposeOverlays(inventory);
  const dryRun = applyOverlayProposal(proposal, root, { dryRun: true, yes: false, backup: true, proposalPath: '.sloom/proposals/overlays.json' });
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.writes.length, 6);
  assert.equal(existsSync(join(root, '.sloom', 'overlays', 'skills', `${proposal.changes[0].id}.json`)), false);

  const result = applyOverlayProposal(proposal, root, { yes: true, backup: true, proposalPath: '.sloom/proposals/overlays.json' });
  assert.equal(result.applied, true);
  assert.ok(result.backupId);
  assert.equal(result.writes.length, 6);
  assert.equal(existsSync(join(root, result.writes[0].targetPath)), true);

  const rollback = rollbackBackup(result.backupId, root);
  assert.equal(rollback.rolledBack, true);
  assert.equal(rollback.actions.length, 6);
  assert.equal(existsSync(join(root, result.writes[0].targetPath)), false);
});

test('indexes example skills and lints catalog', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  assert.equal(catalog.skills.length, 6);
  assert.ok(catalog.skills.some(skill => skill.id === 'implementation.targeted-fix'));
  assert.ok(catalog.skills.every(skill => skill.source?.path?.startsWith('examples/skills/')));
  const lint = lintCatalog(catalog);
  assert.equal(lint.ok, true);
});


test('runs workflow plan with artifact runtime and can resume paused runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  cpSync(join(process.cwd(), 'blueprints'), join(root, 'blueprints'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  const task = '给 sLoom CLI 增加 status 命令展示 inventory catalog overlays backups';
  const route = routeTask(task, { catalog });
  const blueprint = readBlueprint('feature', root);
  const plan = createPlan({ task, catalog, blueprint, route });

  const paused = runWorkflowPlan(plan, catalog, root, { maxNodes: 2 });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.nodes.filter(node => node.status === 'succeeded').length, 2);
  assert.equal(existsSync(join(root, paused.runDir, 'run-state.json')), true);
  assert.equal(existsSync(join(root, paused.runDir, 'events.jsonl')), true);
  assert.equal(existsSync(join(root, paused.runDir, 'artifacts', 'manifest.json')), true);

  const resumed = resumeWorkflowRun(paused.id, catalog, root);
  assert.equal(resumed.status, 'succeeded');
  assert.ok(resumed.nodes.every(node => node.status === 'succeeded'));
  assert.ok(resumed.nodes.some(node => node.artifacts.length > 0));
  const state = readRunState(paused.id, root);
  assert.equal(state.status, 'succeeded');
  const manifest = JSON.parse(readFileSync(join(root, resumed.runDir, 'artifacts', 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.some(artifact => artifact.name === 'review-result'));
  assert.ok(manifest.artifacts.every(artifact => artifact.checksum?.startsWith('sha256:')));
  assert.ok(listRuns(root).some(run => run.id === paused.id && run.status === 'succeeded'));
});

test('routes and plans a bugfix DAG', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  cpSync(join(process.cwd(), 'blueprints'), join(root, 'blueprints'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  const task = '修复资源列表搜索为空时报错';
  const route = routeTask(task, { catalog });
  const blueprint = readBlueprint('bugfix', root);
  const plan = createPlan({ task, catalog, blueprint, route });
  assert.equal(plan.kind, 'WorkflowPlan');
  assert.ok(plan.spec.nodes.some(n => n.skill === 'implementation.targeted-fix'));
  assert.ok(plan.spec.nodes.some(n => n.skill === 'test.regression'));
  assert.equal(validatePlan(plan, catalog).ok, true);
});


test('auto executor runs safe shell nodes and records command output', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  const plan = {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'WorkflowPlan',
    metadata: { id: 'safe-shell-test', blueprint: 'test' },
    spec: {
      task: { description: '验证 safe shell executor', intent: 'feature', risk: 'low' },
      nodes: [{ id: 'regression', skill: 'test.regression', executor: 'shell', inputs: [], outputs: ['test-report'] }],
      gates: []
    }
  };
  const result = runWorkflowPlan(plan, catalog, root, { executorMode: 'auto', shellCommands: { regression: [{ command: process.execPath, args: ['--version'] }] } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.nodes[0].status, 'succeeded');
  const manifest = JSON.parse(readFileSync(join(root, result.runDir, 'artifacts', 'manifest.json'), 'utf8'));
  const report = manifest.artifacts.find(artifact => artifact.name === 'test-report');
  assert.equal(report.executor, 'shell');
  assert.equal(report.metadata.status, 'passed');
  assert.ok(readFileSync(join(root, report.path), 'utf8').includes('Safe command results'));
});

test('auto executor creates agent handoff packages and accepts submitted artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  cpSync(join(process.cwd(), 'blueprints'), join(root, 'blueprints'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  const task = '给 sLoom CLI 增加 status 命令展示 inventory catalog overlays backups';
  const route = routeTask(task, { catalog });
  const blueprint = readBlueprint('feature', root);
  const plan = createPlan({ task, catalog, blueprint, route, id: 'handoff-flow' });

  const result = runWorkflowPlan(plan, catalog, root, { executorMode: 'auto' });
  assert.equal(result.status, 'paused');
  assert.ok(result.nodes.some(node => node.status === 'succeeded' && node.skill === 'repo.exploration'));
  const handoffNode = result.nodes.find(node => node.status === 'handoff-ready');
  assert.ok(handoffNode);
  const state = readRunState(result.id, root);
  const handoffState = state.nodes.find(node => node.id === handoffNode.id);
  assert.ok(existsSync(join(root, handoffState.handoff.task)));
  assert.ok(existsSync(join(root, handoffState.handoff.inputs)));
  assert.ok(existsSync(join(root, handoffState.handoff.expectedOutputs)));

  const submittedFile = join(root, 'requirement.spec.md');
  writeFileSync(submittedFile, '# Requirement Spec\n\nStatus: generated\n\n- Acceptance: status command lists sLoom runtime assets.\n');
  const submission = submitRunArtifact(result.id, handoffNode.id, 'requirement.spec', submittedFile, catalog, root, { executor: 'codex' });
  assert.equal(submission.nodeStatus, 'succeeded');
  assert.equal(submission.artifact.name, 'requirement.spec');

  const resumed = resumeWorkflowRun(result.id, catalog, root, { executorMode: 'auto' });
  assert.equal(resumed.status, 'paused');
  assert.ok(resumed.nodes.some(node => node.status === 'handoff-ready'));
});

test('lists executor adapters and maps sLoom policy to CAO allowedTools', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  const adapters = listExecutorAdapters(root);
  assert.ok(adapters.some(adapter => adapter.id === 'codex'));
  assert.ok(adapters.some(adapter => adapter.id === 'claude-code'));
  assert.ok(adapters.some(adapter => adapter.id === 'cao'));

  assert.deepEqual(mapPolicyToCaoAllowedTools({ permissions: ['filesystem.read'] }), ['@cao-mcp-server', 'fs_read', 'fs_list']);
  assert.deepEqual(mapPolicyToCaoAllowedTools({ permissions: ['filesystem.write', 'shell.test'] }), ['@cao-mcp-server', 'fs_read', 'fs_list', 'fs_write', 'execute_bash']);
});

test('cao executor creates dispatch package and launch script for agent node', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  cpSync(join(process.cwd(), 'blueprints'), join(root, 'blueprints'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  const task = '给 sLoom CLI 增加 status 命令展示 inventory catalog overlays backups';
  const route = routeTask(task, { catalog });
  const blueprint = readBlueprint('feature', root);
  const plan = createPlan({ task, catalog, blueprint, route, id: 'cao-dispatch-flow' });

  const result = runWorkflowPlan(plan, catalog, root, { executorMode: 'cao' });
  assert.equal(result.status, 'paused');
  assert.ok(result.nodes.some(node => node.status === 'succeeded' && node.skill === 'repo.exploration'));
  const handoffNode = result.nodes.find(node => node.status === 'handoff-ready');
  assert.ok(handoffNode);
  assert.equal(handoffNode.handoff.adapter, 'cao');
  assert.equal(handoffNode.handoff.executor, 'cao');
  assert.ok(handoffNode.handoff.dispatch.endsWith('/dispatch.json'));
  assert.ok(handoffNode.handoff.launchScript.endsWith('/launch-cao.sh'));
  assert.ok(handoffNode.handoff.allowedTools.includes('@cao-mcp-server'));

  const dispatch = JSON.parse(readFileSync(join(root, handoffNode.handoff.dispatch), 'utf8'));
  assert.equal(dispatch.kind, 'ExecutorDispatch');
  assert.equal(dispatch.adapter, 'cao');
  assert.equal(dispatch.node, handoffNode.id);
  assert.ok(dispatch.allowedTools.includes('fs_read'));
  assert.equal(existsSync(join(root, dispatch.prompt)), true);
  assert.equal(existsSync(join(root, handoffNode.handoff.launchScript)), true);
  assert.equal(Boolean(statSync(join(root, handoffNode.handoff.launchScript)).mode & 0o111), true);
  const launch = readFileSync(join(root, handoffNode.handoff.launchScript), 'utf8');
  assert.ok(launch.includes('cao launch'));
  assert.ok(launch.includes('--allowed-tools'));
});

test('codex executor creates dispatch package for agent node', () => {
  const root = mkdtempSync(join(tmpdir(), 'sloom-test-'));
  cpSync(join(process.cwd(), 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(process.cwd(), 'packs'), join(root, 'packs'), { recursive: true });
  cpSync(join(process.cwd(), 'blueprints'), join(root, 'blueprints'), { recursive: true });
  const catalog = indexSkills(['examples/skills'], root);
  const task = '给 sLoom CLI 增加 status 命令展示 inventory catalog overlays backups';
  const route = routeTask(task, { catalog });
  const blueprint = readBlueprint('feature', root);
  const plan = createPlan({ task, catalog, blueprint, route, id: 'codex-dispatch-flow' });

  const result = runWorkflowPlan(plan, catalog, root, { executorMode: 'codex' });
  assert.equal(result.status, 'paused');
  const handoffNode = result.nodes.find(node => node.status === 'handoff-ready');
  assert.ok(handoffNode);
  assert.equal(handoffNode.handoff.adapter, 'codex');
  assert.ok(handoffNode.handoff.dispatch.endsWith('/dispatch.json'));
  const dispatch = JSON.parse(readFileSync(join(root, handoffNode.handoff.dispatch), 'utf8'));
  assert.equal(dispatch.adapter, 'codex');
  assert.equal(dispatch.command.command, 'codex');
  assert.equal(existsSync(join(root, dispatch.prompt)), true);
});
