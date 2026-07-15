#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createPlan,
  ensureSloom,
  indexSkills,
  lintCatalog,
  planToMermaid,
  readBlueprint,
  readCatalog,
  readConfig,
  readJson,
  readPack,
  routeTask,
  validatePlan,
  writeJson
} from '../../core/src/index.js';

const args = process.argv.slice(2);
const command = args[0];
const root = process.cwd();

try {
  if (!command || command === '--help' || command === '-h') help();
  else if (command === '--version' || command === '-v') console.log('0.1.0');
  else if (command === 'init') cmdInit(args.slice(1));
  else if (command === 'index') cmdIndex(args.slice(1));
  else if (command === 'skills') cmdSkills(args.slice(1));
  else if (command === 'route') cmdRoute(args.slice(1));
  else if (command === 'plan') cmdPlan(args.slice(1));
  else if (command === 'validate') cmdValidate(args.slice(1));
  else if (command === 'graph') cmdGraph(args.slice(1));
  else if (command === 'run') cmdRun(args.slice(1));
  else die(`Unknown command: ${command}\nRun: sloom --help`);
} catch (error) {
  die(error?.stack || error?.message || String(error));
}

function cmdInit(argv) {
  const dir = ensureSloom(root);
  const config = readConfig(root);
  console.log(`Initialized ${dir}`);
  console.log(`Config: ${JSON.stringify(config, null, 2)}`);
}

function cmdIndex(argv) {
  const paths = argv.filter(a => !a.startsWith('-'));
  const catalog = indexSkills(paths, root);
  console.log(`Indexed ${catalog.skills.length} skill(s) into .sloom/catalog.json`);
  for (const skill of catalog.skills) console.log(`- ${skill.id} (${skill.title})`);
}

function cmdSkills(argv) {
  const sub = argv[0];
  const catalog = readCatalog(root);
  if (sub === 'list' || !sub) {
    for (const skill of catalog.skills ?? []) {
      console.log(`${skill.id}\t${skill.version}\t${skill.title}`);
    }
  } else if (sub === 'show') {
    const id = argv[1];
    const skill = catalog.skills?.find(s => s.id === id);
    if (!skill) die(`Skill not found: ${id}`);
    printJson(skill);
  } else if (sub === 'lint') {
    const result = lintCatalog(catalog);
    reportValidation(result);
    if (!result.ok || (argv.includes('--strict') && result.warnings.length)) process.exit(1);
  } else {
    die(`Unknown skills subcommand: ${sub}`);
  }
}

function cmdRoute(argv) {
  const task = positional(argv)[0] ?? getOption(argv, '--task');
  if (!task) die('Usage: sloom route "<task>" [--pack frontend-delivery] [--json]');
  const catalog = ensureCatalog();
  const pack = readPack(getOption(argv, '--pack') ?? readConfig(root).defaultPack, root);
  const result = routeTask(task, { catalog, pack, limit: Number(getOption(argv, '--limit') ?? 8) });
  if (argv.includes('--json')) printJson(result);
  else {
    console.log(`Intent: ${result.intent}`);
    console.log(`Risk: ${result.risk}`);
    console.log(`Complexity: ${result.complexity}`);
    console.log(`Suggested blueprint: ${result.suggestedBlueprint}`);
    console.log('Candidates:');
    for (const item of result.candidates) console.log(`- ${item.id} score=${item.score} confidence=${item.confidence} (${item.reasons.join('; ')})`);
  }
}

function cmdPlan(argv) {
  const task = getOption(argv, '--task') ?? positional(argv)[0];
  if (!task) die('Usage: sloom plan --task "<task>" [--blueprint bugfix] [--out .sloom/plans/task.json]');
  const catalog = ensureCatalog();
  const pack = readPack(getOption(argv, '--pack') ?? readConfig(root).defaultPack, root);
  const route = routeTask(task, { catalog, pack });
  const blueprintName = getOption(argv, '--blueprint') ?? route.suggestedBlueprint ?? readConfig(root).defaultBlueprint;
  const blueprint = readBlueprint(blueprintName, root);
  const plan = createPlan({ task, catalog, blueprint, route, id: getOption(argv, '--id') });
  const out = getOption(argv, '--out');
  if (out) {
    writeJson(resolve(root, out), plan);
    console.log(`Wrote ${out}`);
  } else if (argv.includes('--mermaid')) {
    console.log(planToMermaid(plan));
  } else {
    printJson(plan);
  }
}

function cmdValidate(argv) {
  const file = positional(argv)[0];
  if (!file) die('Usage: sloom validate <plan.json>');
  const plan = readJson(resolve(root, file));
  const catalog = readCatalog(root);
  const result = validatePlan(plan, catalog);
  reportValidation(result);
  if (!result.ok) process.exit(1);
}

function cmdGraph(argv) {
  const file = positional(argv)[0];
  if (!file) die('Usage: sloom graph <plan.json> [--out graph.mmd]');
  const plan = readJson(resolve(root, file));
  const mermaid = planToMermaid(plan);
  const out = getOption(argv, '--out');
  if (out) {
    writeFileSync(resolve(root, out), `${mermaid}\n`);
    console.log(`Wrote ${out}`);
  } else console.log(mermaid);
}

function cmdRun(argv) {
  const file = positional(argv)[0];
  if (!file) die('Usage: sloom run <plan.json> --dry-run');
  const dryRun = argv.includes('--dry-run');
  const plan = readJson(resolve(root, file));
  const catalog = readCatalog(root);
  const validation = validatePlan(plan, catalog);
  if (!validation.ok) {
    reportValidation(validation);
    process.exit(1);
  }
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + plan.metadata.id;
  const runDir = join(root, '.sloom', 'runs', runId);
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  writeJson(join(runDir, 'plan.lock.json'), plan);
  const events = [];
  for (const node of plan.spec.nodes ?? []) {
    const event = { time: new Date().toISOString(), node: node.id, skill: node.skill, status: dryRun ? 'dry-run' : 'skipped', executor: node.executor };
    events.push(event);
    console.log(`${dryRun ? '[dry-run]' : '[skip]'} ${node.id} -> ${node.skill} via ${node.executor}`);
  }
  writeFileSync(join(runDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  console.log(`Trace written to ${runDir}`);
  if (!dryRun) console.log('MVP currently supports deterministic trace creation; real executors are next milestone. Use --dry-run for now.');
}

function ensureCatalog() {
  ensureSloom(root);
  let catalog = readCatalog(root);
  if (!catalog.skills?.length) catalog = indexSkills(readConfig(root).skillPaths ?? ['./examples/skills'], root);
  return catalog;
}

function help() {
  console.log(`sLoom — Skill-first Orchestrator CLI\n\nUsage:\n  sloom init\n  sloom index [skill-path ...]\n  sloom skills list|show <id>|lint [--strict]\n  sloom route "<task>" [--pack <id>] [--json]\n  sloom plan --task "<task>" [--blueprint bugfix|feature] [--out plan.json]\n  sloom validate <plan.json>\n  sloom graph <plan.json> [--out graph.mmd]\n  sloom run <plan.json> --dry-run\n\nAlias: skillforge\n`);
}

function getOption(argv, name) {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const item = argv.find(a => a.startsWith(prefix));
  return item ? item.slice(prefix.length) : undefined;
}

function positional(argv) {
  const result = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function reportValidation(result) {
  if (result.ok) console.log('OK');
  for (const warning of result.warnings ?? []) console.warn(`warning: ${warning}`);
  for (const error of result.errors ?? []) console.error(`error: ${error}`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function die(message) {
  console.error(message);
  process.exit(1);
}
