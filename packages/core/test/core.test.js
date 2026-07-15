import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverlayProposal, createPlan, indexSkills, lintCatalog, listRuns, proposeOverlays, readBlueprint, readRunState, resumeWorkflowRun, rollbackBackup, routeTask, runWorkflowPlan, scanSkills, validatePlan, writeInventory } from '../src/index.js';


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
