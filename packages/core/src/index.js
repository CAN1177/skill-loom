import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
