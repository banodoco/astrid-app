import { build } from 'vite';
import { resolveHostedRuntimeOrigin } from './hosted-build-origin.mjs';
import { emitPackBuildArtifact } from './installer/pack-build-artifact.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.VITE_RUNTIME_ORIGIN = resolveHostedRuntimeOrigin();
process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID = '';
process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID = '';
process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID = '';

await build({ configFile: 'config/vite/vite.config.ts' });

const { origin } = JSON.parse(readFileSync('config/hosted-origin.json', 'utf8'));
emitPackBuildArtifact({ dist: path.resolve('dist'), origin });
