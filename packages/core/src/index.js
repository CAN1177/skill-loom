import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

export const SLOOM_DIR = '.sloom';
export const CATALOG_FILE = join(SLOOM_DIR, 'catalog.json');
export const INVENTORY_FILE = join(SLOOM_DIR, 'inventory.json');
export const BACKUPS_DIR = join(SLOOM_DIR, 'backups');

export function ensureSloom(root = process.cwd()) {
  const dir = join(root, SLOOM_DIR);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'plans'), { recursive: true });
  mkdirSync(join(dir, 'runs'), { recursive: true });
  mkdirSync(join(dir, 'overlays', 'skills'), { recursive: true });
  mkdirSync(join(dir, 'proposals'), { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });
  if (!existsSync(join(root, 'sloom.config.json'))) {
    writeJson(join(root, 'sloom.config.json'), {
      $schema: './schemas/sloom.config.schema.json',
      apiVersion: 'sloom.dev/v1alpha1',
      skillPaths: ['./examples/skills'],
      defaultPack: 'frontend-delivery',
      defaultBlueprint: 'bugfix',
      catalog: CATALOG_FILE,
      inventory: INVENTORY_FILE
    });
  }
  if (!existsSync(join(root, CATALOG_FILE))) {
    writeJson(join(root, CATALOG_FILE), { apiVersion: 'sloom.dev/v1alpha1', generatedAt: new Date().toISOString(), skills: [] });
  }
  return dir;
}

export function readConfig(root = process.cwd()) {
  const file = join(root, 'sloom.config.json');
  if (!existsSync(file)) return { skillPaths: ['./examples/skills'], defaultPack: 'frontend-delivery', defaultBlueprint: 'bugfix', catalog: CATALOG_FILE, inventory: INVENTORY_FILE };
  return readJson(file);
}

export function readCatalog(root = process.cwd()) {
  const file = join(root, CATALOG_FILE);
  if (!existsSync(file)) return { apiVersion: 'sloom.dev/v1alpha1', generatedAt: null, skills: [] };
  return readJson(file);
}

export function writeCatalog(catalog, root = process.cwd()) {
  ensureSloom(root);
  catalog.generatedAt = new Date().toISOString();
  writeJson(join(root, CATALOG_FILE), catalog);
}

export function scanSkills(paths, root = process.cwd()) {
  const config = readConfig(root);
  const requestedPaths = paths.length ? paths : config.skillPaths ?? ['./examples/skills'];
  const entries = [];
  const seen = new Set();
  const overlays = readSkillOverlays(root);

  for (const input of requestedPaths) {
    const absolute = expandHome(resolveMaybe(root, input));
    if (!existsSync(absolute)) continue;
    for (const skillDir of findSkillDirs(absolute)) {
      const key = normalizePathKey(skillDir);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(readInventoryEntry(skillDir, root, overlays));
    }
  }

  entries.sort((a, b) => a.metadata.inferredId.localeCompare(b.metadata.inferredId));
  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'SkillInventory',
    generatedAt: new Date().toISOString(),
    roots: requestedPaths,
    entries
  };
}

export function writeInventory(inventory, root = process.cwd(), file = INVENTORY_FILE) {
  ensureSloom(root);
  writeJson(resolveMaybe(root, file), inventory);
}

export function proposeOverlays(inventory, options = {}) {
  const { includeExisting = false } = options;
  const changes = [];
  for (const entry of inventory.entries ?? []) {
    const hasOverlay = entry.metadata?.origin === 'local-skill-with-overlay';
    if (hasOverlay && !includeExisting) continue;
    const id = entry.metadata.inferredId;
    const targetPath = entry.suggestedOverlayPath ?? join(SLOOM_DIR, 'overlays', 'skills', `${id}.json`);
    changes.push({
      action: hasOverlay ? 'review-existing-overlay' : 'upsert-overlay',
      id,
      targetPath,
      reason: hasOverlay ? 'Skill already has overlay metadata; include for review.' : 'Skill has no sLoom overlay; propose a non-invasive metadata skeleton.',
      overlay: createOverlaySkeleton(entry)
    });
  }
  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'SkillOverlayProposal',
    generatedAt: new Date().toISOString(),
    inventoryGeneratedAt: inventory.generatedAt ?? null,
    changes
  };
}


export function applyOverlayProposal(proposal, root = process.cwd(), options = {}) {
  const { yes = false, dryRun = false, backup = false, proposalPath = null } = options;
  assertOverlayProposal(proposal);
  ensureSloom(root);
  const changes = (proposal.changes ?? []).filter(change => change.action === 'upsert-overlay');
  const planned = changes.map(change => planOverlayWrite(change, root));
  const rejected = planned.find(item => !isInsideLocalOverlayDir(item.absoluteTarget, root));
  if (rejected) throw new Error(`Refusing to write outside ${join(SLOOM_DIR, 'overlays', 'skills')}: ${rejected.targetPath}`);

  const result = {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'SkillOverlayApplyResult',
    dryRun,
    applied: false,
    backupId: null,
    backupManifest: null,
    writes: planned.map(({ absoluteTarget, overlay, ...item }) => item)
  };

  if (dryRun || !yes) return result;

  let manifest = null;
  if (backup) {
    manifest = createBackupManifest({ proposal, proposalPath, planned, root });
    writeBackupManifest(manifest, root);
    result.backupId = manifest.id;
    result.backupManifest = relative(root, join(root, BACKUPS_DIR, manifest.id, 'manifest.json'));
  }

  for (const item of planned) {
    writeJson(item.absoluteTarget, item.overlay);
  }

  result.applied = true;
  return result;
}

export function rollbackBackup(backupId, root = process.cwd(), options = {}) {
  if (!backupId) throw new Error('backupId is required');
  const backupRoot = join(root, BACKUPS_DIR, backupId);
  const manifestFile = join(backupRoot, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`Backup manifest not found: ${join(BACKUPS_DIR, backupId, 'manifest.json')}`);
  const manifest = readJson(manifestFile);
  const dryRun = options.dryRun ?? false;
  const actions = [];

  for (const file of manifest.files ?? []) {
    const target = resolveMaybe(root, file.targetPath);
    if (!isInsideLocalOverlayDir(target, root)) throw new Error(`Refusing to rollback outside ${join(SLOOM_DIR, 'overlays', 'skills')}: ${file.targetPath}`);
    if (file.existedBefore) {
      const backupFile = join(backupRoot, file.backupFile);
      actions.push({ action: 'restore', targetPath: file.targetPath, backupFile: file.backupFile });
      if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(backupFile, target);
      }
    } else {
      actions.push({ action: 'remove-created', targetPath: file.targetPath });
      if (!dryRun && existsSync(target)) rmSync(target, { force: true });
    }
  }

  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'SkillOverlayRollbackResult',
    dryRun,
    backupId,
    rolledBack: !dryRun,
    actions
  };
}

function assertOverlayProposal(proposal) {
  if (!proposal || proposal.kind !== 'SkillOverlayProposal') throw new Error('Expected kind=SkillOverlayProposal');
  if (!Array.isArray(proposal.changes)) throw new Error('SkillOverlayProposal.changes must be an array');
}

function planOverlayWrite(change, root) {
  if (!change.id) throw new Error('Proposal change is missing id');
  if (!change.overlay || typeof change.overlay !== 'object') throw new Error(`Proposal change ${change.id} is missing overlay`);
  const targetPath = change.targetPath ?? join(SLOOM_DIR, 'overlays', 'skills', `${change.id}.json`);
  const absoluteTarget = resolveMaybe(root, targetPath);
  const previousExists = existsSync(absoluteTarget);
  const previousHash = previousExists ? `sha256:${sha256(readFileSync(absoluteTarget, 'utf8'))}` : null;
  return {
    id: change.id,
    action: change.action,
    targetPath: relative(root, absoluteTarget),
    absoluteTarget,
    previousExists,
    previousHash,
    nextHash: `sha256:${sha256(JSON.stringify(change.overlay, null, 2) + '\n')}`,
    overlay: change.overlay
  };
}

function createBackupManifest({ proposal, proposalPath, planned, root }) {
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backupRoot = join(root, BACKUPS_DIR, id);
  const files = [];
  for (const item of planned) {
    const backupFile = item.previousExists ? join('files', item.targetPath.replace(/[^a-zA-Z0-9._-]/g, '__')) : null;
    if (item.previousExists) {
      mkdirSync(join(backupRoot, dirname(backupFile)), { recursive: true });
      copyFileSync(item.absoluteTarget, join(backupRoot, backupFile));
    }
    files.push({
      id: item.id,
      targetPath: item.targetPath,
      existedBefore: item.previousExists,
      backupFile,
      previousHash: item.previousHash,
      nextHash: item.nextHash
    });
  }
  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'SkillOverlayBackup',
    id,
    createdAt: new Date().toISOString(),
    proposalPath: proposalPath ? relative(root, resolveMaybe(root, proposalPath)) : null,
    proposalHash: `sha256:${sha256(JSON.stringify(proposal, null, 2) + '\n')}`,
    files
  };
}

function writeBackupManifest(manifest, root) {
  writeJson(join(root, BACKUPS_DIR, manifest.id, 'manifest.json'), manifest);
}

function isInsideLocalOverlayDir(file, root) {
  const overlayRoot = normalizePathKey(resolve(root, SLOOM_DIR, 'overlays', 'skills'));
  const target = normalizePathKey(resolve(file));
  return target === overlayRoot || target.startsWith(`${overlayRoot}/`);
}

function createOverlaySkeleton(entry) {
  const id = entry.metadata.inferredId;
  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'SkillOverlay',
    metadata: {
      id,
      version: '0.1.0-local',
      title: entry.metadata.title,
      source: {
        type: 'local-skill',
        path: entry.metadata.sourcePath,
        origin: entry.metadata.origin,
        vault: inferVaultFromPath(entry.metadata.sourcePath),
        fingerprint: entry.fingerprints?.skillMd
      },
      enabled: true
    },
    spec: {
      intents: inferIntentsFromText(`${entry.metadata.title} ${entry.summary ?? ''}`),
      capabilities: inferCapabilitiesFromText(`${entry.metadata.title} ${entry.summary ?? ''}`),
      inputs: { required: ['task.description'], optional: [] },
      outputs: [],
      execution: { preferredExecutor: 'manual', workspace: 'current', timeoutMinutes: 20, parallelSafe: true },
      policy: { risk: 'low', permissions: ['filesystem.read'], denyCommands: ['rm -rf', 'git push'] },
      routing: { includeKeywords: inferKeywords(entry), tags: [] }
    }
  };
}


export function indexSkills(paths, root = process.cwd()) {
  ensureSloom(root);
  const discovered = [];
  const overlays = readSkillOverlays(root);
  for (const input of paths.length ? paths : readConfig(root).skillPaths ?? ['./examples/skills']) {
    const absolute = expandHome(resolveMaybe(root, input));
    if (!existsSync(absolute)) continue;
    for (const skillDir of findSkillDirs(absolute)) {
      discovered.push(readSkill(skillDir, root, overlays));
    }
  }
  const byId = new Map();
  for (const skill of discovered) byId.set(skill.id, skill);
  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const catalog = { apiVersion: 'sloom.dev/v1alpha1', generatedAt: new Date().toISOString(), skills };
  writeCatalog(catalog, root);
  return catalog;
}

export function lintCatalog(catalog) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const outputProducers = new Map();

  for (const skill of catalog.skills ?? []) {
    if (!skill.id) errors.push(`Skill at ${skill.skillPath} is missing metadata.id`);
    if (skill.id && ids.has(skill.id)) errors.push(`Duplicate skill id: ${skill.id}`);
    ids.add(skill.id);
    if (!skill.version) warnings.push(`${skill.id}: missing metadata.version`);
    if (!skill.skillPath) errors.push(`${skill.id}: missing metadata.skillPath`);
    if (!skill.summary || skill.summary.length < 8) warnings.push(`${skill.id}: SKILL.md summary is too short`);
    if (!Array.isArray(skill.outputs) || skill.outputs.length === 0) warnings.push(`${skill.id}: missing spec.outputs`);
    const permissions = skill.policy?.permissions ?? [];
    for (const permission of permissions) {
      if (['shell.unrestricted', 'network.unrestricted', 'filesystem.write.all'].includes(permission)) warnings.push(`${skill.id}: dangerous permission '${permission}'`);
    }
    for (const command of skill.policy?.denyCommands ?? []) {
      if (String(command).includes('rm -rf /')) warnings.push(`${skill.id}: denyCommands contains broad destructive command pattern`);
    }
    for (const out of skill.outputs ?? []) {
      if (!outputProducers.has(out)) outputProducers.set(out, []);
      outputProducers.get(out).push(skill.id);
    }
  }

  for (const [artifact, producers] of outputProducers.entries()) {
    if (producers.length > 1) warnings.push(`artifact '${artifact}' has multiple producers: ${producers.join(', ')}`);
  }

  for (const skill of catalog.skills ?? []) {
    const required = new Set([...(skill.inputs?.required ?? []), ...(skill.requires?.artifacts ?? [])]);
    for (const artifact of required) {
      if (artifact.startsWith('task.') || artifact.startsWith('repo.')) continue;
      if (!outputProducers.has(artifact)) warnings.push(`${skill.id}: required artifact '${artifact}' has no producer in catalog`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function routeTask(task, options = {}) {
  const { catalog = { skills: [] }, pack = null, limit = 8 } = options;
  const allowed = pack?.spec?.include ? new Set(pack.spec.include) : null;
  const terms = tokenize(task);
  const scored = [];
  const excluded = [];

  for (const skill of catalog.skills ?? []) {
    if (allowed && !allowed.has(skill.id)) {
      excluded.push({ id: skill.id, reason: `not included by pack ${pack.metadata?.id ?? ''}`.trim() });
      continue;
    }
    const haystack = [
      skill.id,
      skill.title,
      skill.summary,
      ...(skill.intents ?? []),
      ...(skill.capabilities ?? []),
      ...(skill.tags ?? []),
      ...(skill.routing?.includeKeywords ?? [])
    ].join(' ').toLowerCase();
    const includeKeywords = (skill.routing?.includeKeywords ?? []).map(String);
    const excludeKeywords = (skill.routing?.excludeKeywords ?? []).map(String);
    if (excludeKeywords.some(k => task.toLowerCase().includes(k.toLowerCase()))) {
      excluded.push({ id: skill.id, reason: 'matched exclude keyword' });
      continue;
    }
    let score = 0;
    const reasons = [];
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
    for (const keyword of includeKeywords) {
      if (task.toLowerCase().includes(keyword.toLowerCase())) {
        score += 6;
        reasons.push(`matched keyword '${keyword}'`);
      }
    }
    for (const intent of skill.intents ?? []) {
      if (task.toLowerCase().includes(String(intent).toLowerCase())) {
        score += 5;
        reasons.push(`matched intent '${intent}'`);
      }
    }
    if ((skill.tags ?? []).includes('review')) score += 0.5;
    if ((skill.tags ?? []).includes('test') || (skill.tags ?? []).includes('verification')) score += 0.5;
    if (score > 0) scored.push({ skill, score, confidence: Math.min(0.99, score / 20), reasons: reasons.length ? reasons : ['lexical metadata match'] });
    else excluded.push({ id: skill.id, reason: 'no lexical match' });
  }

  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const candidates = scored.slice(0, limit).map(item => ({
    id: item.skill.id,
    title: item.skill.title,
    score: Number(item.score.toFixed(2)),
    confidence: Number(item.confidence.toFixed(2)),
    outputs: item.skill.outputs ?? [],
    reasons: item.reasons
  }));
  return {
    task,
    intent: inferIntent(task),
    risk: inferRisk(task),
    complexity: inferComplexity(task),
    candidates,
    excluded,
    suggestedBlueprint: inferIntent(task) === 'bugfix' ? 'bugfix' : 'feature'
  };
}

export function createPlan({ task, catalog, blueprint = null, route = null, id = null }) {
  const intent = route?.intent ?? inferIntent(task);
  const risk = route?.risk ?? inferRisk(task);
  const requiredArtifacts = blueprintRequiredArtifacts(blueprint, intent, risk);
  const initialArtifacts = new Set(['task.description']);
  const selectedSkills = new Map();
  const produced = new Set(initialArtifacts);

  const skills = [...(catalog.skills ?? [])];
  const byOutput = new Map();
  for (const skill of skills) {
    for (const out of skill.outputs ?? []) {
      if (!byOutput.has(out)) byOutput.set(out, []);
      byOutput.get(out).push(skill);
    }
  }

  for (const artifact of requiredArtifacts) selectProducer(artifact);

  function selectProducer(artifact, stack = []) {
    if (produced.has(artifact)) return;
    const candidates = byOutput.get(artifact) ?? [];
    if (candidates.length === 0) return;
    const skill = chooseSkill(candidates, task, route);
    if (!selectedSkills.has(skill.id)) {
      selectedSkills.set(skill.id, skill);
      const deps = [...(skill.inputs?.required ?? []), ...(skill.requires?.artifacts ?? [])];
      for (const dep of deps) {
        if (stack.includes(dep)) continue;
        selectProducer(dep, [...stack, artifact]);
      }
      for (const out of skill.outputs ?? []) produced.add(out);
    }
  }

  const nodes = [];
  const nodeBySkill = new Map();
  for (const skill of selectedSkills.values()) {
    const node = {
      id: makeNodeId(skill.id, nodes.length + 1),
      skill: skill.id,
      executor: skill.execution?.preferredExecutor ?? 'shell',
      inputs: skill.inputs?.required ?? [],
      outputs: skill.outputs ?? [],
      dependsOn: [],
      selectedBecause: explainSelection(skill, task)
    };
    nodes.push(node);
    nodeBySkill.set(skill.id, node);
  }

  const outputToNode = new Map();
  for (const node of nodes) for (const out of node.outputs ?? []) outputToNode.set(out, node.id);
  const skillById = new Map(skills.map(skill => [skill.id, skill]));
  for (const node of nodes) {
    const skill = skillById.get(node.skill);
    const optionalProducedInputs = (skill?.inputs?.optional ?? []).filter(input => outputToNode.has(input));
    node.inputs = [...new Set([...(node.inputs ?? []), ...optionalProducedInputs])];
    const deps = new Set();
    for (const input of node.inputs ?? []) {
      const producer = outputToNode.get(input);
      if (producer && producer !== node.id) deps.add(producer);
    }
    node.dependsOn = [...deps];
    if (node.dependsOn.length === 0) delete node.dependsOn;
  }

  const ordered = topologicalSort(nodes);
  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'WorkflowPlan',
    metadata: {
      id: id ?? (slugify(task).slice(0, 48) || `plan-${Date.now()}`),
      createdAt: new Date().toISOString(),
      blueprint: blueprint?.metadata?.id ?? (intent === 'bugfix' ? 'bugfix' : 'feature')
    },
    spec: {
      task: { description: task, intent, risk },
      nodes: ordered,
      gates: defaultGates(intent, risk, ordered)
    }
  };
}


export function runWorkflowPlan(plan, catalog, root = process.cwd(), options = {}) {
  ensureSloom(root);
  const validation = validatePlan(plan, catalog);
  if (!validation.ok) throw new Error(`Invalid workflow plan: ${validation.errors.join('; ')}`);

  const dryRun = options.dryRun ?? false;
  const executorMode = normalizeExecutorMode(options.executorMode ?? options.executor ?? 'local');
  const now = new Date().toISOString();
  const runId = options.runId ?? makeRunId(plan);
  const runDir = join(root, SLOOM_DIR, 'runs', runId);
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  mkdirSync(join(runDir, 'logs'), { recursive: true });

  const state = createInitialRunState(plan, runId, now, dryRun, executorMode);
  const manifest = createInitialArtifactManifest(plan, runDir, root, now);
  writeJson(join(runDir, 'plan.lock.json'), plan);
  writeRunState(runDir, state);
  writeArtifactManifest(runDir, manifest);
  appendRunEvent(runDir, { type: dryRun ? 'run.dry_started' : 'run.started', runId, planId: plan.metadata?.id });

  const result = executeRunState({ state, manifest, plan, catalog, root, runDir, dryRun, maxNodes: numberOption(options.maxNodes), executorMode, shellCommands: options.shellCommands });
  return summarizeRunResult(result.state, root, runDir);
}

export function resumeWorkflowRun(runId, catalog, root = process.cwd(), options = {}) {
  if (!runId) throw new Error('runId is required');
  const runDir = join(root, SLOOM_DIR, 'runs', runId);
  const stateFile = join(runDir, 'run-state.json');
  const planFile = join(runDir, 'plan.lock.json');
  if (!existsSync(stateFile)) throw new Error(`Run state not found: ${join(SLOOM_DIR, 'runs', runId, 'run-state.json')}`);
  if (!existsSync(planFile)) throw new Error(`Plan lock not found: ${join(SLOOM_DIR, 'runs', runId, 'plan.lock.json')}`);
  const state = readJson(stateFile);
  const plan = readJson(planFile);
  const manifest = existsSync(join(runDir, 'artifacts', 'manifest.json')) ? readJson(join(runDir, 'artifacts', 'manifest.json')) : createInitialArtifactManifest(plan, runDir, root, new Date().toISOString());

  const executorMode = normalizeExecutorMode(options.executorMode ?? options.executor ?? state.execution?.mode ?? 'local');
  state.execution = { ...(state.execution ?? {}), mode: executorMode };
  for (const node of state.nodes ?? []) {
    if (['running', 'failed', 'blocked', 'paused'].includes(node.status)) node.status = 'pending';
  }
  state.status = 'running';
  state.resumedAt = new Date().toISOString();
  appendRunEvent(runDir, { type: 'run.resumed', runId });
  const result = executeRunState({ state, manifest, plan, catalog, root, runDir, dryRun: false, maxNodes: numberOption(options.maxNodes), executorMode, shellCommands: options.shellCommands });
  return summarizeRunResult(result.state, root, runDir);
}

export function readRunState(runId, root = process.cwd()) {
  return readJson(join(root, SLOOM_DIR, 'runs', runId, 'run-state.json'));
}

export function submitRunArtifact(runId, nodeId, artifactName, sourceFile, catalog, root = process.cwd(), options = {}) {
  if (!runId || !nodeId || !artifactName || !sourceFile) throw new Error('runId, nodeId, artifactName, and sourceFile are required');
  const runDir = join(root, SLOOM_DIR, 'runs', runId);
  const stateFile = join(runDir, 'run-state.json');
  const planFile = join(runDir, 'plan.lock.json');
  if (!existsSync(stateFile)) throw new Error(`Run state not found: ${join(SLOOM_DIR, 'runs', runId, 'run-state.json')}`);
  if (!existsSync(planFile)) throw new Error(`Plan lock not found: ${join(SLOOM_DIR, 'runs', runId, 'plan.lock.json')}`);
  const source = resolveMaybe(root, sourceFile);
  if (!existsSync(source)) throw new Error(`Artifact source not found: ${sourceFile}`);
  const state = readJson(stateFile);
  const plan = readJson(planFile);
  const manifest = existsSync(join(runDir, 'artifacts', 'manifest.json')) ? readJson(join(runDir, 'artifacts', 'manifest.json')) : createInitialArtifactManifest(plan, runDir, root, new Date().toISOString());
  const node = (plan.spec?.nodes ?? []).find(item => item.id === nodeId);
  if (!node) throw new Error(`Node not found in plan: ${nodeId}`);
  if (!(node.outputs ?? []).includes(artifactName)) throw new Error(`Node ${nodeId} does not declare output '${artifactName}'`);
  const nodeState = (state.nodes ?? []).find(item => item.id === nodeId);
  if (!nodeState) throw new Error(`Node not found in run state: ${nodeId}`);
  const skill = (catalog.skills ?? []).find(item => item.id === node.skill) ?? { id: node.skill, title: node.skill };
  const content = readFileSync(source, 'utf8');
  const status = options.status ?? inferArtifactStatus(content, artifactName);
  const record = writeArtifactRecord({
    manifest,
    root,
    runDir,
    node,
    skill,
    outputName: artifactName,
    content,
    metadata: { status, title: artifactTitle(artifactName), executor: options.executor ?? node.executor ?? 'agent', submittedFrom: relative(root, source) },
    executor: options.executor ?? node.executor ?? 'agent'
  });
  nodeState.artifacts = [...new Set([...(nodeState.artifacts ?? []), record.path])];
  const producedByNode = new Set((manifest.artifacts ?? []).filter(item => item.node === nodeId).map(item => item.name));
  if ((node.outputs ?? []).every(name => producedByNode.has(name))) {
    nodeState.status = 'succeeded';
    nodeState.finishedAt = new Date().toISOString();
    delete nodeState.handoff;
    delete nodeState.error;
  }
  state.status = (state.nodes ?? []).some(item => item.status === 'handoff-ready') ? 'paused' : state.status;
  state.updatedAt = new Date().toISOString();
  manifest.generatedAt = state.updatedAt;
  writeRunState(runDir, state);
  writeArtifactManifest(runDir, manifest);
  appendRunEvent(runDir, { type: 'artifact.submitted', runId, node: nodeId, artifact: artifactName, path: record.path, status });
  return { runId, nodeId, artifact: record, nodeStatus: nodeState.status, runStatus: state.status };
}

export function listRuns(root = process.cwd()) {
  const runsDir = join(root, SLOOM_DIR, 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const id = entry.name;
      const stateFile = join(runsDir, id, 'run-state.json');
      if (!existsSync(stateFile)) return { id, status: 'unknown', planId: null, updatedAt: null };
      const state = readJson(stateFile);
      return { id, status: state.status, planId: state.plan?.id ?? null, updatedAt: state.updatedAt ?? state.createdAt, nodes: state.nodes?.length ?? 0 };
    })
    .sort((a, b) => String(b.updatedAt ?? b.id).localeCompare(String(a.updatedAt ?? a.id)));
}

export function listExecutorAdapters(root = process.cwd()) {
  return [
    { id: 'local', kind: 'runtime', available: true, description: 'Deterministic local artifact materializer; never mutates source files.' },
    { id: 'shell', kind: 'runtime', available: true, description: 'Safe shell executor with sLoom policy allowlist.' },
    { id: 'handoff', kind: 'agent-handoff', available: true, description: 'Generic agent handoff package for human/agent execution.' },
    { id: 'codex', kind: 'agent-dispatch', command: 'codex', available: isCommandAvailable('codex', root), description: 'Codex CLI dispatch package; explicit human/agent attach required.' },
    { id: 'claude-code', kind: 'agent-dispatch', command: 'claude', available: isCommandAvailable('claude', root), description: 'Claude Code dispatch package; explicit human/agent attach required.' },
    { id: 'cao', kind: 'cao-dispatch', command: 'cao', available: isCommandAvailable('cao', root), description: 'CLI Agent Orchestrator dispatch package with allowedTools mapping.' }
  ];
}

export function mapPolicyToCaoAllowedTools(policy = {}) {
  const permissions = policy.permissions ?? [];
  const tools = new Set(['@cao-mcp-server']);
  if (permissions.includes('filesystem.read')) {
    tools.add('fs_read');
    tools.add('fs_list');
  }
  if (permissions.includes('filesystem.write')) {
    tools.add('fs_read');
    tools.add('fs_list');
    tools.add('fs_write');
  }
  if (permissions.includes('shell.readonly') || permissions.includes('shell.test')) tools.add('execute_bash');
  if (permissions.includes('network.read') || permissions.includes('web.fetch')) tools.add('web_fetch');
  return [...tools];
}

function executeRunState({ state, manifest, plan, catalog, root, runDir, dryRun, maxNodes = Infinity, executorMode = 'local', shellCommands = null }) {
  const ordered = topologicalSort(plan.spec?.nodes ?? []);
  const stateById = new Map((state.nodes ?? []).map(node => [node.id, node]));
  const skillById = new Map((catalog.skills ?? []).map(skill => [skill.id, skill]));
  let executed = 0;
  let paused = false;
  state.status = dryRun ? 'dry-run' : 'running';
  state.startedAt ??= new Date().toISOString();

  for (const node of ordered) {
    const nodeState = stateById.get(node.id);
    if (!nodeState) continue;
    if (nodeState.status === 'succeeded') continue;
    if (nodeState.status === 'handoff-ready') {
      paused = true;
      break;
    }
    if (executed >= maxNodes) {
      paused = true;
      break;
    }
    const dependencyStates = (node.dependsOn ?? []).map(id => stateById.get(id));
    const unmet = dependencyStates.filter(dep => dep?.status !== 'succeeded' && dep?.status !== 'dry-run');
    if (unmet.length) {
      nodeState.status = 'blocked';
      nodeState.blockedBy = unmet.map(dep => dep.id);
      appendRunEvent(runDir, { type: 'node.blocked', node: node.id, blockedBy: nodeState.blockedBy });
      continue;
    }

    nodeState.attempts += 1;
    nodeState.startedAt = new Date().toISOString();
    nodeState.status = dryRun ? 'dry-run' : 'running';
    appendRunEvent(runDir, { type: dryRun ? 'node.dry_run' : 'node.started', node: node.id, skill: node.skill, executor: node.executor });

    if (dryRun) {
      nodeState.finishedAt = new Date().toISOString();
      nodeState.status = 'dry-run';
      appendRunEvent(runDir, { type: 'node.dry_finished', node: node.id });
    } else {
      const skill = skillById.get(node.skill) ?? { id: node.skill, title: node.skill };
      const result = executeNodeWithAdapter({ node, skill, plan, manifest, root, runDir, executorMode, shellCommands });
      nodeState.artifacts = result.outputs?.map(record => record.path) ?? [];
      if (result.status === 'handoff-ready') {
        nodeState.status = 'handoff-ready';
        nodeState.handoff = result.handoff;
        nodeState.finishedAt = null;
        paused = true;
        appendRunEvent(runDir, { type: 'node.handoff_ready', node: node.id, executor: result.executor, handoff: result.handoff });
      } else if (result.status === 'failed') {
        nodeState.status = 'failed';
        nodeState.finishedAt = new Date().toISOString();
        nodeState.error = result.error ?? 'executor failed';
        appendRunEvent(runDir, { type: 'node.failed', node: node.id, error: nodeState.error, artifacts: nodeState.artifacts });
      } else {
        nodeState.finishedAt = new Date().toISOString();
        nodeState.status = 'succeeded';
        appendRunEvent(runDir, { type: 'node.succeeded', node: node.id, executor: result.executor, artifacts: nodeState.artifacts });
      }
    }
    executed += 1;
    state.updatedAt = new Date().toISOString();
    writeRunState(runDir, state);
    writeArtifactManifest(runDir, manifest);
    if (paused) break;
  }

  if (paused) {
    state.status = 'paused';
    appendRunEvent(runDir, { type: 'run.paused', runId: state.id, maxNodes });
  } else if (dryRun) {
    state.status = 'dry-run';
    appendRunEvent(runDir, { type: 'run.dry_finished', runId: state.id });
  } else if ((state.nodes ?? []).some(node => ['failed', 'blocked'].includes(node.status))) {
    state.status = 'failed';
    appendRunEvent(runDir, { type: 'run.failed', runId: state.id });
  } else {
    state.gates = evaluateGates(plan, manifest);
    state.status = state.gates.every(gate => gate.status === 'passed' || gate.status === 'skipped') ? 'succeeded' : 'failed';
    appendRunEvent(runDir, { type: state.status === 'succeeded' ? 'run.succeeded' : 'run.failed', runId: state.id, gates: state.gates });
  }
  state.updatedAt = new Date().toISOString();
  state.finishedAt = ['succeeded', 'failed', 'dry-run'].includes(state.status) ? state.updatedAt : null;
  writeRunState(runDir, state);
  writeArtifactManifest(runDir, manifest);
  return { state, manifest };
}


function selectExecutorAdapter({ node, skill, executorMode }) {
  if (executorMode === 'local') return 'local';
  const preferred = node.executor ?? skill.execution?.preferredExecutor ?? 'manual';
  if (executorMode === 'auto') {
    if (preferred === 'shell' && hasShellPermission(skill)) return 'shell';
    if (isAgentExecutor(preferred)) return 'handoff';
    return 'local';
  }
  if (executorMode === 'shell') return preferred === 'shell' && hasShellPermission(skill) ? 'shell' : 'local';
  if (executorMode === 'handoff') return isAgentExecutor(preferred) ? 'handoff' : 'local';
  if (['codex', 'claude-code', 'cao'].includes(executorMode)) {
    if (preferred === 'shell' && hasShellPermission(skill)) return 'shell';
    if (isAgentExecutor(preferred) || preferred === executorMode) return executorMode;
    return 'local';
  }
  return 'local';
}

function executeShellNode({ node, skill, plan, manifest, root, runDir, shellCommands }) {
  const permissions = skill.policy?.permissions ?? [];
  if (!hasShellPermission(skill)) return { status: 'failed', executor: 'shell', outputs: [], error: `Skill ${skill.id} does not allow shell execution` };
  const commands = commandsForShellNode({ node, skill, root, shellCommands });
  const denied = commands.find(command => !isAllowedShellCommand(command, permissions, skill.policy?.denyCommands ?? []));
  if (denied) return { status: 'failed', executor: 'shell', outputs: [], error: `Command is not allowed by sLoom safe shell policy: ${formatCommand(denied)}` };

  const startedAt = new Date().toISOString();
  const results = commands.map(command => runSafeCommand(command, root, skill.execution?.timeoutMinutes));
  const allPassed = results.every(result => result.status === 0);
  const inputArtifacts = resolveInputArtifacts(node.inputs ?? [], manifest);
  const outputs = [];
  for (const outputName of node.outputs ?? []) {
    const status = outputName === 'test-report' ? (allPassed ? 'passed' : 'failed') : 'generated';
    const content = renderShellArtifact({ outputName, node, skill, plan, inputArtifacts, commands: results, status, startedAt, root });
    outputs.push(writeArtifactRecord({ manifest, root, runDir, node, skill, outputName, content, metadata: { status, title: artifactTitle(outputName), executor: 'shell', commands: results.map(commandSummary) }, executor: 'shell' }));
  }
  manifest.generatedAt = new Date().toISOString();
  return { status: allPassed ? 'succeeded' : 'failed', executor: 'shell', outputs, error: allPassed ? null : 'one or more safe shell commands failed' };
}

function executeHandoffNode({ node, skill, plan, manifest, root, runDir, adapter = 'handoff' }) {
  const inputArtifacts = resolveInputArtifacts(node.inputs ?? [], manifest);
  const handoffDir = join(runDir, 'handoffs', safePathSegment(node.id));
  mkdirSync(handoffDir, { recursive: true });
  const expectedOutputs = (node.outputs ?? []).map(name => ({ name, suggestedFile: join('artifacts', safePathSegment(node.id), `${safePathSegment(name)}.md`) }));
  const inputs = inputArtifacts.map(item => ({ name: item.name, path: item.path, checksum: item.checksum, metadata: item.metadata ?? {} }));
  const taskMd = renderHandoffTask({ node, skill, plan, inputs, expectedOutputs, root });
  writeFileSync(join(handoffDir, 'task.md'), taskMd);
  writeJson(join(handoffDir, 'inputs.json'), { apiVersion: 'sloom.dev/v1alpha1', kind: 'AgentHandoffInputs', node: node.id, inputs });
  writeJson(join(handoffDir, 'expected-outputs.json'), { apiVersion: 'sloom.dev/v1alpha1', kind: 'AgentHandoffExpectedOutputs', node: node.id, outputs: expectedOutputs });
  const dispatch = adapter === 'handoff' ? null : createAgentDispatchPackage({ adapter, node, skill, plan, root, runDir, handoffDir, inputs, expectedOutputs });
  return {
    status: 'handoff-ready',
    executor: adapter,
    outputs: [],
    handoff: {
      adapter,
      executor: adapter === 'handoff' ? (node.executor ?? skill.execution?.preferredExecutor ?? 'agent') : adapter,
      task: relative(root, join(handoffDir, 'task.md')),
      inputs: relative(root, join(handoffDir, 'inputs.json')),
      expectedOutputs: relative(root, join(handoffDir, 'expected-outputs.json')),
      ...(dispatch ? { dispatch: dispatch.manifest, launchScript: dispatch.launchScript, status: dispatch.status, allowedTools: dispatch.allowedTools, sessionName: dispatch.sessionName } : {})
    }
  };
}

function createAgentDispatchPackage({ adapter, node, skill, plan, root, runDir, handoffDir, inputs, expectedOutputs }) {
  const now = new Date().toISOString();
  const runId = basename(runDir);
  const dispatchDir = join(runDir, 'dispatches', safePathSegment(node.id), safePathSegment(adapter));
  mkdirSync(dispatchDir, { recursive: true });
  const promptFile = join(dispatchDir, 'prompt.md');
  const statusFile = join(dispatchDir, 'status.json');
  const manifestFile = join(dispatchDir, 'dispatch.json');
  const sessionName = `sloom-${safePathSegment(runId).slice(0, 40)}-${safePathSegment(node.id)}`.slice(0, 80);
  const allowedTools = adapter === 'cao' ? mapPolicyToCaoAllowedTools(skill.policy ?? {}) : [];
  const prompt = renderAgentDispatchPrompt({ adapter, node, skill, plan, inputs, expectedOutputs, runId });
  writeFileSync(promptFile, prompt);
  const dispatch = {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'ExecutorDispatch',
    id: `${runId}:${node.id}:${adapter}`,
    runId,
    node: node.id,
    skill: skill.id ?? node.skill,
    adapter,
    provider: adapter,
    status: 'created',
    createdAt: now,
    workingDirectory: root,
    sessionName,
    prompt: relative(root, promptFile),
    sourceHandoff: relative(root, join(handoffDir, 'task.md')),
    expectedOutputs,
    inputs,
    policy: {
      permissions: skill.policy?.permissions ?? [],
      denyCommands: skill.policy?.denyCommands ?? []
    },
    allowedTools,
    command: suggestedDispatchCommand({ adapter, root, promptFile, sessionName, allowedTools })
  };
  writeJson(manifestFile, dispatch);
  writeJson(statusFile, { apiVersion: 'sloom.dev/v1alpha1', kind: 'ExecutorDispatchStatus', dispatch: dispatch.id, status: 'created', updatedAt: now, sessionName, logs: [] });
  const launchScript = adapter === 'cao' ? writeCaoLaunchScript({ dispatchDir, promptFile, root, sessionName, allowedTools }) : null;
  return {
    manifest: relative(root, manifestFile),
    status: relative(root, statusFile),
    launchScript: launchScript ? relative(root, launchScript) : null,
    allowedTools,
    sessionName
  };
}

function suggestedDispatchCommand({ adapter, root, promptFile, sessionName, allowedTools }) {
  if (adapter === 'cao') {
    return {
      command: 'cao',
      args: ['launch', '--agents', '${SLOOM_CAO_PROFILE:-sloom_worker}', '--headless', '--async', '--session-name', sessionName, '--working-directory', root, ...allowedTools.flatMap(tool => ['--allowed-tools', tool]), '<prompt-from-file>'],
      promptFile: relative(root, promptFile)
    };
  }
  if (adapter === 'claude-code') return { command: 'claude', args: ['<', relative(root, promptFile)], promptFile: relative(root, promptFile), note: 'Run Claude Code in this workspace and provide the prompt file content.' };
  if (adapter === 'codex') return { command: 'codex', args: ['<', relative(root, promptFile)], promptFile: relative(root, promptFile), note: 'Run Codex CLI in this workspace and provide the prompt file content.' };
  return { command: adapter, args: [], promptFile: relative(root, promptFile) };
}

function writeCaoLaunchScript({ dispatchDir, promptFile, root, sessionName, allowedTools }) {
  const script = join(dispatchDir, 'launch-cao.sh');
  const allowed = allowedTools.map(tool => ` --allowed-tools ${shellQuote(tool)}`).join('');
  const content = [
    '#!/usr/bin/env sh',
    'set -eu',
    `PROMPT_FILE=${shellQuote(promptFile)}`,
    `cao launch --agents "${'${SLOOM_CAO_PROFILE:-sloom_worker}'}" --headless --async --session-name ${shellQuote(sessionName)} --working-directory ${shellQuote(root)}${allowed} "$(cat "$PROMPT_FILE")"`,
    ''
  ].join('\n');
  writeFileSync(script, content);
  try { chmodSync(script, 0o755); } catch {}
  return script;
}

function renderAgentDispatchPrompt({ adapter, node, skill, plan, inputs, expectedOutputs, runId }) {
  return [
    `# sLoom ${adapter} dispatch: ${node.id}`,
    '',
    `You are a real agent executor for sLoom run \`${runId}\`. Execute only this frozen workflow node; do not modify plan.lock.json or other run-state files except by using sLoom CLI commands documented below.`,
    '',
    '## User task',
    '',
    plan.spec?.task?.description ?? '',
    '',
    '## Node contract',
    '',
    `- Node: \`${node.id}\``,
    `- Skill: \`${skill.id ?? node.skill}\` (${skill.title ?? node.skill})`,
    `- Adapter: \`${adapter}\``,
    `- Skill source: ${skill.source?.path ?? skill.skillPath ?? ''}`,
    '',
    '## Inputs',
    '',
    ...(inputs.length ? inputs.map(item => `- ${item.name}: ${item.path ?? '(missing)'} ${item.checksum ? `(${item.checksum})` : ''}`) : ['- None']),
    '',
    '## Expected outputs',
    '',
    ...(expectedOutputs.length ? expectedOutputs.map(item => `- ${item.name}: produce Markdown, then submit with \`sloom artifact put ${runId} ${node.id} ${item.name} <file> --executor ${adapter}\``) : ['- None']),
    '',
    '## Safety and policy',
    '',
    `- Permissions: ${(skill.policy?.permissions ?? []).join(', ') || '(none declared)'}`,
    `- Deny commands: ${(skill.policy?.denyCommands ?? []).join(', ') || '(none)'}`,
    '- Do not run destructive commands. Do not push to git remotes unless the human explicitly asks.',
    '- If implementation changes files, include changed file paths and verification commands in the submitted artifact.',
    '- If you cannot complete the node, write a failure artifact explaining the blocker instead of editing run-state by hand.',
    ''
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function executeNodeWithAdapter({ node, skill, plan, manifest, root, runDir, executorMode, shellCommands }) {
  const adapter = selectExecutorAdapter({ node, skill, executorMode });
  if (adapter === 'shell') return executeShellNode({ node, skill, plan, manifest, root, runDir, shellCommands });
  if (['handoff', 'codex', 'claude-code', 'cao'].includes(adapter)) return executeHandoffNode({ node, skill, plan, manifest, root, runDir, adapter });
  const outputs = executeDeterministicNode({ node, skill, plan, manifest, root, runDir, adapter: 'local' });
  return { status: 'succeeded', executor: 'local', outputs };
}

function executeDeterministicNode({ node, skill, plan, manifest, root, runDir, adapter = 'local' }) {
  const inputArtifacts = resolveInputArtifacts(node.inputs ?? [], manifest);
  const outputs = [];
  for (const outputName of node.outputs ?? []) {
    const artifact = renderArtifact({ outputName, node, skill, plan, inputArtifacts });
    outputs.push(writeArtifactRecord({ manifest, root, runDir, node, skill, outputName, content: artifact.content, metadata: artifact.metadata, executor: adapter, inputs: inputArtifacts }));
  }
  manifest.generatedAt = new Date().toISOString();
  return outputs;
}

function writeArtifactRecord({ manifest, root, runDir, node, skill, outputName, content, metadata, executor, inputs = null }) {
  const inputArtifacts = inputs ?? resolveInputArtifacts(node.inputs ?? [], manifest);
  const file = join(runDir, 'artifacts', safePathSegment(node.id), `${safePathSegment(outputName)}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  const record = {
    name: outputName,
    path: relative(root, file),
    checksum: `sha256:${sha256(content)}`,
    node: node.id,
    skill: skill.id ?? node.skill,
    executor,
    attempt: 1,
    createdAt: new Date().toISOString(),
    inputs: inputArtifacts.map(item => ({ name: item.name, path: item.path, checksum: item.checksum })),
    metadata
  };
  manifest.artifacts.push(record);
  return record;
}

function normalizeExecutorMode(value) {
  const mode = String(value ?? 'local').toLowerCase();
  if (['local', 'auto', 'shell', 'handoff', 'codex', 'claude-code', 'cao'].includes(mode)) return mode;
  return 'local';
}

function hasShellPermission(skill) {
  const permissions = skill.policy?.permissions ?? [];
  return permissions.includes('shell.readonly') || permissions.includes('shell.test');
}

function isAgentExecutor(executor) {
  return ['codex', 'claude', 'claude-code', 'agent', 'human'].includes(String(executor ?? '').toLowerCase());
}

function commandsForShellNode({ node, skill, root, shellCommands }) {
  const keyed = shellCommands?.[node.id] ?? shellCommands?.[skill.id];
  if (Array.isArray(keyed)) return normalizeShellCommands(keyed);
  if ((node.outputs ?? []).includes('test-report')) {
    if (existsSync(join(root, 'package.json'))) return [{ command: 'npm', args: ['test'] }];
    return [{ command: process.execPath, args: ['--version'] }];
  }
  if ((node.outputs ?? []).includes('repo.context') && existsSync(join(root, '.git'))) {
    return [
      { command: 'git', args: ['status', '--short'] },
      { command: 'git', args: ['diff', '--stat'] }
    ];
  }
  return [{ command: process.execPath, args: ['--version'] }];
}

function normalizeShellCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.map(command => {
    if (Array.isArray(command)) return { command: String(command[0]), args: command.slice(1).map(String) };
    if (typeof command === 'string') return { command, args: [] };
    return { command: String(command.command), args: (command.args ?? []).map(String) };
  });
}

function isAllowedShellCommand(command, permissions, denyCommands) {
  const formatted = formatCommand(command);
  for (const denied of denyCommands ?? []) {
    if (denied && formatted.includes(String(denied))) return false;
  }
  const base = basename(command.command);
  const args = command.args ?? [];
  if ((permissions ?? []).includes('shell.readonly')) {
    if (base === 'git') return [['status', '--short'], ['diff', '--stat'], ['ls-files']].some(allowed => sameArgs(args, allowed));
    if ((base === 'node' || base === 'nodejs') && args.length === 1 && args[0] === '--version') return true;
  }
  if ((permissions ?? []).includes('shell.test')) {
    if (base === 'npm') return sameArgs(args, ['test']) || sameArgs(args, ['run', 'check']);
    if ((base === 'node' || base === 'nodejs') && args[0] === '--check' && args.length === 2) return isSafeRelativePath(args[1]);
    if ((base === 'node' || base === 'nodejs') && args.length === 1 && args[0] === '--version') return true;
  }
  return false;
}

function runSafeCommand(command, root, timeoutMinutes = 5) {
  const startedAt = new Date().toISOString();
  const timeout = Math.max(1000, Math.min(Number(timeoutMinutes || 5) * 60_000, 10 * 60_000));
  const result = spawnSync(command.command, command.args ?? [], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 * 2 });
  return {
    command: formatCommand(command),
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: trimCommandOutput(result.stdout),
    stderr: trimCommandOutput(result.stderr || result.error?.message || ''),
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function renderShellArtifact({ outputName, node, skill, plan, inputArtifacts, commands, status, startedAt, root }) {
  const lines = [
    `# ${artifactTitle(outputName)}`,
    '',
    `- Artifact: \`${outputName}\``,
    `- Node: \`${node.id}\``,
    `- Skill: \`${node.skill}\` (${skill.title ?? skill.id ?? node.skill})`,
    '- Executor: `shell`',
    `- Status: ${status}`,
    `- Started at: ${startedAt}`,
    `- Finished at: ${new Date().toISOString()}`,
    '',
    '## Task',
    '',
    plan.spec?.task?.description ?? '',
    '',
    '## Inputs',
    '',
    ...(inputArtifacts.length ? inputArtifacts.map(item => `- ${item.name}: ${item.path}`) : ['- None']),
    '',
    '## Safe command results',
    ''
  ];
  for (const result of commands) {
    lines.push(`### ${result.command}`, '', `- Exit: ${result.status}${result.signal ? ` (${result.signal})` : ''}`, '', 'stdout:', '```', result.stdout || '(empty)', '```', '', 'stderr:', '```', result.stderr || '(empty)', '```', '');
  }
  if (outputName === 'repo.context') {
    lines.push('## Repository snapshot', '', ...repositorySnapshot(root), '');
  }
  return lines.join('\n');
}

function renderHandoffTask({ node, skill, plan, inputs, expectedOutputs }) {
  return [
    `# sLoom Agent Handoff: ${node.id}`,
    '',
    `You are executing a sLoom workflow node with the real agent executor \`${node.executor ?? skill.execution?.preferredExecutor ?? 'agent'}\`.`,
    '',
    '## Task',
    '',
    plan.spec?.task?.description ?? '',
    '',
    '## Skill',
    '',
    `- ID: \`${skill.id ?? node.skill}\``,
    `- Title: ${skill.title ?? node.skill}`,
    `- Summary: ${skill.summary ?? ''}`,
    `- Source: ${skill.source?.path ?? skill.skillPath ?? ''}`,
    '',
    '## Inputs',
    '',
    ...(inputs.length ? inputs.map(item => `- ${item.name}: ${item.path ?? '(missing)'}`) : ['- None']),
    '',
    '## Expected outputs',
    '',
    ...(node.outputs ?? []).map(name => `- ${name}: write a Markdown artifact, then submit with \`sloom artifact put ${'${RUN_ID}'} ${node.id} ${name} <file>\``),
    '',
    '## Execution rules',
    '',
    '- Respect the skill policy and current workspace boundaries.',
    '- Do not run destructive commands such as `rm -rf` or `git push` unless the human explicitly asks.',
    '- For implementation nodes, list changed files and verification commands in `implementation.summary`.',
    '- For review nodes, set `Status: approved` only when the change is acceptable.',
    ''
  ].join('\n');
}

function commandSummary(result) {
  return { command: result.command, status: result.status, signal: result.signal };
}

function formatCommand(command) {
  return [command.command, ...(command.args ?? [])].join(' ');
}

function sameArgs(args, expected) {
  return args.length === expected.length && args.every((arg, index) => arg === expected[index]);
}

function isSafeRelativePath(value) {
  const normalized = normalizePathKey(value);
  return Boolean(normalized) && !normalized.startsWith('../') && !normalized.includes('/../') && !normalized.startsWith('/');
}

function trimCommandOutput(value) {
  const text = String(value ?? '');
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n... <truncated>` : text;
}

function repositorySnapshot(root) {
  const ignored = new Set(['.git', '.sloom', 'node_modules']);
  const lines = ['Top-level files/directories:'];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true }).filter(item => !ignored.has(item.name)).slice(0, 80)) {
      lines.push(`- ${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
    }
  } catch (error) {
    lines.push(`- unable to read repository root: ${error.message}`);
  }
  return lines;
}

function inferArtifactStatus(content, artifactName) {
  const match = String(content).match(/^[-*]?\s*Status:\s*([a-zA-Z0-9_-]+)/mi);
  if (match) return match[1].toLowerCase();
  if (artifactName === 'review-result') return 'approved';
  if (artifactName === 'test-report') return 'passed';
  return 'generated';
}

function renderArtifact({ outputName, node, skill, plan, inputArtifacts }) {
  const status = outputName === 'review-result' ? 'approved' : outputName === 'test-report' ? 'passed' : 'generated';
  const title = artifactTitle(outputName);
  const lines = [
    `# ${title}`,
    '',
    `- Artifact: \`${outputName}\``,
    `- Node: \`${node.id}\``,
    `- Skill: \`${node.skill}\` (${skill.title ?? skill.id ?? node.skill})`,
    `- Executor: \`${node.executor ?? 'manual'}\``,
    `- Status: ${status}`,
    `- Generated at: ${new Date().toISOString()}`,
    '',
    '## Task',
    '',
    plan.spec?.task?.description ?? '',
    '',
    '## Inputs',
    '',
    ...(inputArtifacts.length ? inputArtifacts.map(item => `- ${item.name}: ${item.path}`) : ['- None']),
    '',
    '## Draft',
    '',
    deterministicDraftFor(outputName, node, skill),
    ''
  ];
  return { content: lines.join('\n'), metadata: { status, title } };
}

function deterministicDraftFor(outputName, node, skill) {
  if (outputName === 'repo.context') return 'Repository context should summarize structure, changed surfaces, test entry points, and risk boundaries. This local executor records a deterministic draft artifact; agent executors can replace it with deeper analysis.';
  if (outputName === 'requirement.spec') return 'Requirement spec should capture user goal, acceptance criteria, non-goals, edge cases, and expected artifacts before implementation starts.';
  if (outputName === 'architecture.decision') return 'Architecture decision should document the chosen approach, alternatives considered, affected files/modules, rollout notes, and rollback strategy.';
  if (outputName === 'api.contract') return 'API contract should describe user-facing CLI/API behavior, flags, inputs, outputs, and compatibility expectations.';
  if (outputName === 'source.diff') return 'Source diff artifact is reserved for implementation output. The deterministic local executor does not mutate source files; use an agent or shell executor for real code changes.';
  if (outputName === 'implementation.summary') return 'Implementation summary should list changed files, rationale, behavior changes, and follow-up tasks.';
  if (outputName === 'test-report') return 'Regression test report should include commands run, pass/fail status, coverage notes, and any skipped checks.';
  if (outputName === 'review-result') return 'Review result is approved for this deterministic artifact-runtime smoke run. Real agent review should replace this with findings and sign-off.';
  return `Artifact generated by ${skill.title ?? node.skill}.`;
}

function createInitialRunState(plan, runId, now, dryRun, executorMode = 'local') {
  return {
    apiVersion: 'sloom.dev/v1alpha1',
    kind: 'WorkflowRun',
    id: runId,
    status: dryRun ? 'dry-run' : 'created',
    createdAt: now,
    updatedAt: now,
    plan: { id: plan.metadata?.id ?? null, blueprint: plan.metadata?.blueprint ?? null },
    task: plan.spec?.task ?? {},
    execution: { mode: executorMode },
    nodes: (plan.spec?.nodes ?? []).map(node => ({
      id: node.id,
      skill: node.skill,
      executor: node.executor,
      status: 'pending',
      attempts: 0,
      inputs: node.inputs ?? [],
      outputs: node.outputs ?? [],
      dependsOn: node.dependsOn ?? [],
      artifacts: []
    })),
    gates: (plan.spec?.gates ?? []).map(gate => ({ ...gate, status: 'pending' }))
  };
}

function createInitialArtifactManifest(plan, runDir, root, now) {
  const manifest = { apiVersion: 'sloom.dev/v1alpha1', kind: 'ArtifactManifest', generatedAt: now, artifacts: [] };
  const taskText = plan.spec?.task?.description ?? '';
  const file = join(runDir, 'artifacts', 'context', 'task.description.md');
  mkdirSync(dirname(file), { recursive: true });
  const content = `# Task Description\n\n${taskText}\n`;
  writeFileSync(file, content);
  manifest.artifacts.push({
    name: 'task.description',
    path: relative(root, file),
    checksum: `sha256:${sha256(content)}`,
    node: null,
    skill: null,
    executor: 'user',
    attempt: 0,
    createdAt: now,
    inputs: [],
    metadata: { status: 'provided', title: 'Task Description' }
  });
  return manifest;
}

function resolveInputArtifacts(inputs, manifest) {
  const artifacts = manifest.artifacts ?? [];
  return inputs.map(name => [...artifacts].reverse().find(item => item.name === name) ?? { name, path: null, checksum: null, missing: true });
}

function evaluateGates(plan, manifest) {
  return (plan.spec?.gates ?? []).map(gate => {
    if (gate.type === 'approval') return { ...gate, status: 'skipped', reason: 'approval gates require external approval executor' };
    if (String(gate.expression ?? '').includes("artifacts['review-result'].status == 'approved'")) {
      const review = [...(manifest.artifacts ?? [])].reverse().find(item => item.name === 'review-result');
      return { ...gate, status: review?.metadata?.status === 'approved' ? 'passed' : 'failed' };
    }
    return { ...gate, status: 'skipped', reason: 'unsupported gate expression in local runtime' };
  });
}

function writeRunState(runDir, state) {
  writeJson(join(runDir, 'run-state.json'), state);
}

function writeArtifactManifest(runDir, manifest) {
  writeJson(join(runDir, 'artifacts', 'manifest.json'), manifest);
}

function appendRunEvent(runDir, event) {
  appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
}

function summarizeRunResult(state, root, runDir) {
  return {
    id: state.id,
    status: state.status,
    runDir: relative(root, runDir),
    planId: state.plan?.id ?? null,
    nodes: (state.nodes ?? []).map(node => ({ id: node.id, skill: node.skill, status: node.status, artifacts: node.artifacts ?? [], handoff: node.handoff ?? null })),
    gates: state.gates ?? []
  };
}

function makeRunId(plan) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `${stamp}-${slugify(plan.metadata?.id ?? plan.spec?.task?.description ?? 'run')}`.slice(0, 120);
}

function artifactTitle(name) {
  return String(name).split(/[._-]/).map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ');
}

function safePathSegment(value) {
  return String(value ?? 'artifact').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function numberOption(value) {
  if (value === undefined || value === null || value === '') return Infinity;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

export function validatePlan(plan, catalog) {
  const errors = [];
  const warnings = [];
  if (plan.kind !== 'WorkflowPlan') errors.push('kind must be WorkflowPlan');
  const nodes = plan.spec?.nodes ?? [];
  const ids = new Set();
  const skillIds = new Set((catalog.skills ?? []).map(s => s.id));
  for (const node of nodes) {
    if (!node.id) errors.push('node is missing id');
    if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!node.skill) errors.push(`${node.id}: missing skill`);
    if (node.skill && !skillIds.has(node.skill)) warnings.push(`${node.id}: skill '${node.skill}' is not in catalog`);
    for (const dep of node.dependsOn ?? []) if (!ids.has(dep) && !nodes.some(n => n.id === dep)) errors.push(`${node.id}: depends on unknown node '${dep}'`);
  }
  const cycle = detectCycle(nodes);
  if (cycle) errors.push(`cycle detected: ${cycle.join(' -> ')}`);

  const produced = new Set(['task.description', 'repo.context']);
  for (const node of topologicalSort(nodes)) {
    for (const input of node.inputs ?? []) {
      if (!produced.has(input)) warnings.push(`${node.id}: input '${input}' is not produced by earlier nodes or initial context`);
    }
    for (const out of node.outputs ?? []) produced.add(out);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function planToMermaid(plan) {
  const lines = ['flowchart TD'];
  for (const node of plan.spec?.nodes ?? []) {
    const label = `${node.id}<br/>${node.skill}`.replace(/"/g, '&quot;');
    lines.push(`  ${safeMermaidId(node.id)}["${label}"]`);
  }
  for (const node of plan.spec?.nodes ?? []) {
    for (const dep of node.dependsOn ?? []) lines.push(`  ${safeMermaidId(dep)} --> ${safeMermaidId(node.id)}`);
  }
  return lines.join('\n');
}

export function readBlueprint(idOrFile, root = process.cwd()) {
  if (!idOrFile) return null;
  const file = existsSync(resolveMaybe(root, idOrFile)) ? resolveMaybe(root, idOrFile) : join(root, 'blueprints', `${idOrFile}.json`);
  if (existsSync(file)) return readJson(file);
  return null;
}

export function readPack(idOrFile, root = process.cwd()) {
  if (!idOrFile) return null;
  const direct = resolveMaybe(root, idOrFile);
  const file = existsSync(direct) ? direct : join(root, 'packs', idOrFile, 'pack.json');
  if (existsSync(file)) return readJson(file);
  return null;
}

function isCommandAvailable(command, root = process.cwd()) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { cwd: root, encoding: 'utf8', timeout: 3000 });
  return result.status === 0 && Boolean(String(result.stdout ?? '').trim());
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function inferVaultFromPath(path) {
  const normalized = normalizePathKey(path);
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] === 'examples') return 'examples';
  if (parts[0] === 'packs') return parts[1] ?? 'packs';
  if (normalized.includes('/.codex/skills/')) return 'codex';
  if (normalized.includes('/.agents/skills/')) return 'agents';
  if (normalized.includes('/.claude/skills/')) return 'claude';
  return parts[0] ?? 'local';
}

function inferIntentsFromText(text) {
  const lower = String(text).toLowerCase();
  const intents = new Set();
  if (/bug|fix|修复|缺陷|报错/.test(lower)) intents.add('bugfix');
  if (/feature|需求|新增|实现|开发/.test(lower)) intents.add('feature');
  if (/refactor|重构/.test(lower)) intents.add('refactor');
  return [...intents];
}

function inferCapabilitiesFromText(text) {
  const lower = String(text).toLowerCase();
  const pairs = [
    ['review', /review|审核|检查/],
    ['testing', /test|测试|验证|regression/],
    ['implementation', /implementation|实现|开发|fix/],
    ['requirements', /requirement|需求|验收/],
    ['architecture', /architecture|架构|设计/],
    ['repo-analysis', /repo|repository|仓库|代码库|inspect/]
  ];
  return pairs.filter(([, pattern]) => pattern.test(lower)).map(([capability]) => capability);
}

function inferKeywords(entry) {
  return [...new Set(String(entry.metadata.title ?? '').split(/\s+/).filter(Boolean).slice(0, 6))];
}


function readInventoryEntry(skillDir, root, overlays = { bySourcePath: new Map(), byId: new Map() }) {
  const skillMd = join(skillDir, 'SKILL.md');
  const content = readFileSync(skillMd, 'utf8');
  const title = (content.match(/^#\s+(.+)$/m)?.[1] ?? basename(skillDir)).trim();
  const portableMetadata = readPortableMetadataSummary(skillDir);
  const titleSlug = slugify(title || basename(skillDir));
  const relativePath = relative(root, skillDir);
  const overlay = mergeOverlays(
    overlays.bySourcePath.get(normalizePathKey(skillDir)),
    overlays.bySourcePath.get(normalizePathKey(relativePath)),
    overlays.byId.get(portableMetadata.id),
    overlays.byId.get(titleSlug)
  );
  const inferredId = overlay.metadata?.id ?? portableMetadata.id ?? titleSlug;
  const canonicalTitle = overlay.metadata?.title ?? portableMetadata.title ?? title;
  const skillMdHash = sha256(content);
  return {
    metadata: {
      inferredId,
      title: canonicalTitle,
      sourcePath: relativePath,
      absolutePath: skillDir,
      origin: overlay.metadata?.id ? 'local-skill-with-overlay' : (portableMetadata.kind ? 'local-skill-with-portable-metadata' : 'local-skill'),
      vault: inferVaultFromPath(relativePath),
      enabled: overlay.metadata?.enabled ?? true,
      discoveredAt: new Date().toISOString()
    },
    summary: summarizeMarkdown(content),
    fingerprints: {
      skillMd: `sha256:${skillMdHash}`,
      portableMetadata: portableMetadata.hash ? `sha256:${portableMetadata.hash}` : null,
      overlay: overlay.__sloomFingerprint ? `sha256:${overlay.__sloomFingerprint}` : null
    },
    portableMetadata: portableMetadata.kind ? {
      kind: portableMetadata.kind,
      id: portableMetadata.id,
      title: portableMetadata.title,
      file: portableMetadata.file
    } : null,
    suggestedOverlayPath: join(SLOOM_DIR, 'overlays', 'skills', `${inferredId}.json`)
  };
}

function readPortableMetadataSummary(skillDir) {
  for (const name of ['sloom.json', 'sloom.yaml', 'sloom.yml']) {
    const file = join(skillDir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    try {
      const value = extname(file) === '.json' ? JSON.parse(text) : parseSimpleYaml(text);
      return {
        kind: value.kind,
        id: value.metadata?.id,
        title: value.metadata?.title,
        file,
        hash: sha256(text)
      };
    } catch {
      return { file, hash: sha256(text) };
    }
  }
  return {};
}

function readSkill(skillDir, root, overlays = { bySourcePath: new Map(), byId: new Map() }) {
  const skillMd = join(skillDir, 'SKILL.md');
  const content = readFileSync(skillMd, 'utf8');
  const titleFromMd = (content.match(/^#\s+(.+)$/m)?.[1] ?? basename(skillDir)).trim();
  const inferredId = slugify(titleFromMd || basename(skillDir));
  const sidecar = readSidecar(skillDir);
  const sidecarId = sidecar.metadata?.id;
  const overlay = mergeOverlays(
    overlays.byId.get(inferredId),
    sidecarId ? overlays.byId.get(sidecarId) : null,
    overlays.bySourcePath.get(normalizePathKey(skillDir)),
    overlays.bySourcePath.get(normalizePathKey(relative(root, skillDir)))
  );
  const descriptor = mergeDeep(mergeDeep({ metadata: {}, spec: {} }, sidecar), overlay);
  delete descriptor.__sloomFingerprint;
  const metadata = descriptor.metadata ?? {};
  const spec = descriptor.spec ?? {};
  const id = metadata.id ?? sidecarId ?? inferredId;
  return {
    id,
    version: metadata.version ?? '0.0.0-local',
    title: metadata.title ?? titleFromMd,
    skillPath: metadata.skillPath ?? metadata.source?.path ?? relative(root, skillDir),
    absolutePath: skillDir,
    owners: metadata.owners ?? [],
    summary: summarizeMarkdown(content),
    hash: sha256(content + JSON.stringify(descriptor)),
    source: metadata.source ?? { type: 'local-skill', path: relative(root, skillDir) },
    vault: metadata.source?.vault ?? inferVaultFromPath(metadata.source?.path ?? relative(root, skillDir)),
    origin: metadata.source?.origin ?? (Object.keys(overlay).length ? 'local-skill-with-overlay' : 'local-skill'),
    enabled: metadata.enabled ?? true,
    intents: spec.intents ?? [],
    capabilities: spec.capabilities ?? [],
    inputs: spec.inputs ?? { required: [], optional: [] },
    outputs: spec.outputs ?? [],
    requires: normalizeRequires(spec.dependencies?.requires),
    execution: spec.execution ?? {},
    policy: spec.policy ?? {},
    routing: spec.routing ?? {},
    gates: spec.gates ?? {},
    tags: spec.routing?.tags ?? []
  };
}

function readSkillOverlays(root) {
  const overlays = [];
  for (const dir of [join(root, 'packs'), join(root, SLOOM_DIR, 'overlays', 'skills')]) {
    for (const file of findMetadataFiles(dir)) {
      const value = readMetadataFile(file);
      if (value) {
        value.__sloomFingerprint = sha256(readFileSync(file, 'utf8'));
        overlays.push(value);
      }
    }
  }

  const byId = new Map();
  const bySourcePath = new Map();
  for (const overlay of overlays) {
    const id = overlay.metadata?.id;
    if (id) byId.set(id, mergeDeep(byId.get(id) ?? {}, overlay));
    const sourcePath = overlay.metadata?.source?.path ?? overlay.metadata?.skillPath;
    if (sourcePath) bySourcePath.set(normalizePathKey(resolveMaybe(root, sourcePath)), mergeDeep(bySourcePath.get(normalizePathKey(resolveMaybe(root, sourcePath))) ?? {}, overlay));
    if (sourcePath) bySourcePath.set(normalizePathKey(sourcePath), mergeDeep(bySourcePath.get(normalizePathKey(sourcePath)) ?? {}, overlay));
  }
  return { byId, bySourcePath };
}

function findMetadataFiles(start) {
  const out = [];
  if (!existsSync(start)) return out;
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push(file);
        continue;
      }
      if (entry.isFile() && /^.+\.(json|ya?ml)$/.test(entry.name) && entry.name !== 'pack.json') out.push(file);
    }
  }
  return out.sort();
}

function readMetadataFile(file) {
  try {
    const value = extname(file) === '.json' ? readJson(file) : parseSimpleYaml(readFileSync(file, 'utf8'));
    if (['Skill', 'SkillOverlay'].includes(value.kind)) return value;
  } catch {
    return null;
  }
  return null;
}

function mergeOverlays(...items) {
  return items.filter(Boolean).reduce((acc, item) => mergeDeep(acc, item), {});
}

function mergeDeep(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? mergeDeep(result[key], value) : value;
  }
  return result;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathKey(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/$/, '');
}

function readSidecar(skillDir) {
  const json = join(skillDir, 'sloom.json');
  if (existsSync(json)) return readJson(json);
  const yaml = join(skillDir, 'sloom.yaml');
  if (existsSync(yaml)) return parseSimpleYaml(readFileSync(yaml, 'utf8'));
  const yml = join(skillDir, 'sloom.yml');
  if (existsSync(yml)) return parseSimpleYaml(readFileSync(yml, 'utf8'));
  return { metadata: {}, spec: {} };
}

function findSkillDirs(start) {
  const out = [];
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir || !existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      out.push(dir);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      stack.push(join(dir, entry.name));
    }
  }
  return out.sort();
}

function parseSimpleYaml(text) {
  // Tiny YAML subset parser for metadata overlay examples used by sLoom. Prefer JSON for complex metadata.
  const result = {};
  const stack = [{ indent: -1, value: result }];
  for (const raw of text.split(/\r?\n/)) {
    const withoutComment = raw.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)[0].length;
    const line = withoutComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (line.startsWith('- ')) {
      // Lists of scalars are handled when attached by key; lists of objects are intentionally skipped in this parser.
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    if (rest === '') {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return result;
}

function parseScalar(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).map(unquote);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

function unquote(value) {
  return String(value).replace(/^['"]|['"]$/g, '');
}

function normalizeRequires(requires) {
  const result = { capabilities: [], artifacts: [] };
  if (!Array.isArray(requires)) return result;
  for (const item of requires) {
    if (typeof item === 'string') result.artifacts.push(item);
    else if (item?.artifact) result.artifacts.push(item.artifact);
    else if (item?.capability) result.capabilities.push(item.capability);
  }
  return result;
}

function summarizeMarkdown(content) {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('```'))
    .slice(0, 4)
    .join(' ')
    .slice(0, 500);
}

function chooseSkill(candidates, task, route) {
  const rankedIds = new Map((route?.candidates ?? []).map((c, i) => [c.id, i]));
  return [...candidates].sort((a, b) => {
    const ar = rankedIds.has(a.id) ? rankedIds.get(a.id) : 999;
    const br = rankedIds.has(b.id) ? rankedIds.get(b.id) : 999;
    if (ar !== br) return ar - br;
    return scoreSkill(b, task) - scoreSkill(a, task);
  })[0];
}

function scoreSkill(skill, task) {
  const text = [skill.id, skill.title, skill.summary, ...(skill.capabilities ?? []), ...(skill.tags ?? [])].join(' ').toLowerCase();
  return tokenize(task).reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
}

function blueprintRequiredArtifacts(blueprint, intent, risk) {
  if (blueprint?.spec?.phases) {
    const out = new Set();
    for (const phase of blueprint.spec.phases) {
      for (const artifact of phase.requiredArtifacts ?? []) out.add(artifact);
    }
    return [...out];
  }
  if (intent === 'bugfix') return ['source.diff', 'test-report', 'review-result'];
  const artifacts = ['requirement.spec', 'source.diff', 'test-report', 'review-result'];
  if (risk !== 'low') artifacts.splice(1, 0, 'architecture.decision');
  return artifacts;
}

function defaultGates(intent, risk, nodes = []) {
  const reviewNode = nodes.find(node => (node.outputs ?? []).includes('review-result'))?.id ?? 'review';
  const designNode = nodes.find(node => (node.outputs ?? []).includes('architecture.decision'))?.id ?? 'design';
  const gates = [{ after: reviewNode, type: 'assertion', expression: "artifacts['review-result'].status == 'approved'" }];
  if (intent === 'feature' && risk !== 'low') gates.unshift({ after: designNode, type: 'approval', requiredWhen: "task.risk != 'low'" });
  return gates;
}

function explainSelection(skill, task) {
  const keywords = skill.routing?.includeKeywords ?? [];
  const matched = keywords.filter(k => task.toLowerCase().includes(String(k).toLowerCase()));
  if (matched.length) return `matched task keywords: ${matched.join(', ')}`;
  return `selected as producer for: ${(skill.outputs ?? []).join(', ') || 'declared capability'}`;
}

function topologicalSort(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visited = new Set();
  const visiting = new Set();
  const out = [];
  function visit(node) {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) return;
    visiting.add(node.id);
    for (const dep of node.dependsOn ?? []) {
      const depNode = byId.get(dep);
      if (depNode) visit(depNode);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    out.push(node);
  }
  for (const node of nodes) visit(node);
  return out;
}

function detectCycle(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  function dfs(id) {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id); path.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    path.pop(); visiting.delete(id); visited.add(id);
    return null;
  }
  for (const node of nodes) {
    const cycle = dfs(node.id);
    if (cycle) return cycle;
  }
  return null;
}

function tokenize(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(t => t.length >= 2);
}

function inferIntent(task) {
  const t = task.toLowerCase();
  if (/bug|fix|修复|报错|错误|回归|故障|排障/.test(t)) return 'bugfix';
  if (/refactor|重构/.test(t)) return 'refactor';
  if (/release|发布/.test(t)) return 'release';
  return 'feature';
}

function inferRisk(task) {
  const t = task.toLowerCase();
  if (/生产|权限|rbac|支付|安全|迁移|数据库|跨模块|高风险/.test(t)) return 'high';
  if (/api|接口|架构|缓存|并发|中风险/.test(t)) return 'medium';
  return 'low';
}

function inferComplexity(task) {
  const t = task.toLowerCase();
  if (/跨模块|前后端|全流程|迁移|架构/.test(t) || task.length > 80) return 'large';
  if (/api|权限|测试|review|设计/.test(t) || task.length > 40) return 'medium';
  return 'small';
}

function makeNodeId(skillId, index) {
  const last = skillId.split('.').at(-1) ?? `node-${index}`;
  return slugify(last) || `node-${index}`;
}

function slugify(text) {
  const ascii = String(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || sha256(String(text)).slice(0, 8);
}

function safeMermaidId(id) {
  return String(id).replace(/[^a-zA-Z0-9_]/g, '_');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function expandHome(path) {
  if (path.startsWith('~/')) return join(process.env.HOME ?? '', path.slice(2));
  return path;
}

function resolveMaybe(root, input) {
  const expanded = expandHome(input);
  return expanded.startsWith('/') ? expanded : resolve(root, expanded);
}
