import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const GLOBAL_DIR = process.env.ASSAY_HOME || join(homedir(), '.assay');

/**
 * Walk up from `start` looking for a `.assay` directory.
 *
 * The global directory is skipped: when it lives under the home directory,
 * every path inside home would otherwise "find" it and report the global
 * rubrics as local overrides of themselves.
 */
export function findLocalDir(start = process.cwd()) {
  const global = resolve(GLOBAL_DIR);
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.assay');
    if (existsSync(candidate) && resolve(candidate) !== global) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

/** Local values win, key by key. Questions and thresholds merge one level deep. */
function merge(base, override) {
  if (!base) return override;
  if (!override) return base;
  const out = { ...base, ...override };
  for (const key of ['questions', 'thresholds']) {
    if (base[key] || override[key]) {
      out[key] = { ...(base[key] || {}) };
      for (const [id, value] of Object.entries(override[key] || {})) {
        out[key][id] = { ...(out[key][id] || {}), ...value };
      }
    }
  }
  return out;
}

/**
 * Resolve a rubric by name: the global definition, with the repo's own
 * file layered on top. The questions usually travel; the thresholds and the
 * local definition of a term usually do not.
 */
export function loadRubric(name, { cwd = process.cwd() } = {}) {
  const localDir = findLocalDir(cwd);
  const globalPath = join(GLOBAL_DIR, `${name}.json`);
  const localPath = localDir ? join(localDir, `${name}.json`) : null;

  const global = readJson(globalPath);
  const local = localPath ? readJson(localPath) : null;

  if (!global && !local) {
    const looked = [globalPath, localPath].filter(Boolean).join('\n  ');
    throw new Error(`rubric "${name}" not found. Looked in:\n  ${looked}`);
  }

  const rubric = merge(global, local);
  if (!rubric.questions || Object.keys(rubric.questions).length === 0) {
    throw new Error(`rubric "${name}" has no questions`);
  }

  return {
    ...rubric,
    name: rubric.name || name,
    sources: { global: global ? globalPath : null, local: local ? localPath : null },
  };
}

export { GLOBAL_DIR };
