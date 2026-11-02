import { createHash } from 'node:crypto';

const repository = 'https://github.com/banodoco/VibeComfy.git';
const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;

// readAgent must read bytes from the selected Agent commit, never its working tree.
export async function agentVibecomfyPin(readAgent) {
  const json = (bytes) => JSON.parse(bytes.toString('utf8'));
  async function readRef(ref) {
    if (!ref || typeof ref.path !== 'string' || !/^packs\/[a-zA-Z0-9_.\/-]+$/.test(ref.path) ||
        ref.path.split('/').some(part => !part || part === '.' || part === '..') || !digest.test(ref.sha256 ?? '')) {
      throw new Error('Agent recipe has an invalid data reference');
    }
    const bytes = await readAgent(`astrid/${ref.path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error(`Agent data digest mismatch: ${ref.path}`);
    return json(bytes);
  }
  const index = json(await readAgent('astrid/packs/engine-index.json'));
  if (index.schema !== 'astrid.engine-index.v1' || !Array.isArray(index.entries)) throw new Error('Invalid Agent engine index');
  const entries = index.entries.filter(entry => entry.engine === 'vibecomfy' && entry.platform === 'windows-x86_64-cu130');
  if (entries.length !== 1) throw new Error('Agent engine index needs exactly one VibeComfy recipe');
  const recipe = await readRef(entries[0].recipe);
  if (recipe.schema !== 'astrid.engine-recipe.v1' || recipe.engine !== 'vibecomfy' || recipe.platform !== 'windows-x86_64-cu130' || !Array.isArray(recipe.source_bindings)) throw new Error('Invalid Agent VibeComfy recipe identity');
  const bindings = recipe.source_bindings.filter(binding => binding.name === 'vibecomfy');
  if (bindings.length !== 1 || typeof bindings[0].pin !== 'string') throw new Error('Agent recipe needs exactly one VibeComfy source binding');
  const pins = await readRef(recipe.pins);
  const declared = json(await readAgent('astrid/packs/vibecomfy/pins.json'));
  const bound = pins?.sources?.[bindings[0].pin];
  const source = declared?.sources?.vibecomfy;
  if (pins.schema !== 'astrid.engine-pins.v1' || declared.schema !== 'astrid.engine-pins.v1' ||
      !source || source.repository !== repository || !sha.test(source.revision ?? '') ||
      bound?.repository !== source.repository || bound?.revision !== source.revision) {
    throw new Error('Agent VibeComfy pins are missing, mismatched, or foreign');
  }
  return { sha: source.revision };
}

export function checkVibecomfyPin(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) ||
      Object.keys(actual).length !== 1 || actual.sha !== expected.sha) {
    throw new Error('install-manifest.json vibecomfy identity does not match the selected Agent pin');
  }
}
