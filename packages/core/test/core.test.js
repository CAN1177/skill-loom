import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlan, indexSkills, lintCatalog, proposeOverlays, readBlueprint, routeTask, scanSkills, validatePlan, writeInventory } from '../src/index.js';


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
