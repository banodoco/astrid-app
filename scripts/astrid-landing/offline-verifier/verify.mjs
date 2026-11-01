#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const ajvVersion = require("ajv/package.json").version;

export class VerificationError extends Error {
  constructor(code, field, value, detail) {
    super(`${code} at ${field}${value === undefined ? "" : ` (${JSON.stringify(value)})`}: ${detail}`);
    this.name = "VerificationError";
    this.code = code;
    this.field = field;
    this.value = value;
    this.detail = detail;
  }
}

function fail(code, field, value, detail) {
  throw new VerificationError(code, field, value, detail);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readJson(filePath, field) {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    fail("missing-input", field, filePath, error.message);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    fail("invalid-json", field, filePath, error.message);
  }
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-shape", field, value, "expected an object");
  }
}

function assertFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid-number", field, value, "expected a finite number");
  }
}

function assertEqual(actual, expected, field, detail = "values do not agree") {
  if (actual !== expected) fail("conflicting-identity", field, actual, `${detail}; expected ${JSON.stringify(expected)}`);
}

function validateSha(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("invalid-hash", field, value, "expected a lowercase SHA-256 value");
  }
}

function validateRelativePath(root, value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid-path", field, value, "expected a non-empty relative path");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    fail("external-url", field, value, "URLs are not allowed in an offline fixture");
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail("absolute-path", field, value, "absolute paths are not allowed");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    fail("path-traversal", field, value, "parent traversal is not allowed");
  }
  const candidate = path.resolve(root, value);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("path-escape", field, value, "resolved path escapes fixture root");
  }
  if (!fs.existsSync(candidate)) {
    fail("missing-file", field, value, `resolved file does not exist: ${candidate}`);
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    fail("unreadable-file", field, value, error.message);
  }
  const realRelative = path.relative(fs.realpathSync(root), real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    fail("symlink-escape", field, value, `real path escapes fixture root: ${real}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) fail("not-a-file", field, value, "resolved resource is not a regular file");
  return { absolute: real, relative: value.replaceAll("\\", "/"), size: stat.size };
}

function schemaErrorText(errors) {
  return (errors ?? [])
    .map((error) => `${error.dataPath || "/"} ${error.message}`)
    .sort()
    .join("; ");
}

function checkUnique(values, field) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      fail("invalid-identity", `${field}[${index}]`, value, "expected a non-empty string");
    }
    if (seen.has(value)) fail("duplicate-identity", `${field}[${index}]`, value, "identity already appeared in this namespace");
    seen.add(value);
  }
}

const resourceKeyTokens = new Set([
  "asset",
  "audio",
  "bundle",
  "effect",
  "file",
  "image",
  "media",
  "path",
  "poster",
  "resource",
  "source",
  "thumbnail",
  "uri",
  "url",
  "video",
]);

function classifyResourceKey(key) {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return normalized.split("_").filter(Boolean).some((token) => resourceKeyTokens.has(token));
}

function rejectUnknownResourceMetadata(value, field) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectUnknownResourceMetadata(entry, `${field}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const pointerKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
    const nestedField = `${field}/${pointerKey}`;
    if (classifyResourceKey(key) && nested !== null && nested !== "") {
      fail(
        "unsupported-resource-kind",
        nestedField,
        nested,
        "the vendored schema permits this metadata, but the current exporter contract does not define its dependency semantics",
      );
    }
    rejectUnknownResourceMetadata(nested, nestedField);
  }
}

function inspectOpenSchemaAreas(timeline) {
  const roots = [
    ["/app", timeline.app],
    ["/generation_defaults", timeline.generation_defaults],
    ["/theme_overrides", timeline.theme_overrides],
  ];
  (timeline.clips ?? []).forEach((clip, index) => {
    roots.push([`/clips/${index}/params`, clip.params]);
    roots.push([`/clips/${index}/generation`, clip.generation]);
    roots.push([`/clips/${index}/app`, clip.app]);
    roots.push([`/clips/${index}/entrance/params`, clip.entrance?.params]);
    roots.push([`/clips/${index}/exit/params`, clip.exit?.params]);
    roots.push([`/clips/${index}/continuous/params`, clip.continuous?.params]);
    if (clip.transition && typeof clip.transition === "object") {
      roots.push([`/clips/${index}/transition/params`, clip.transition.params]);
    }
  });
  (timeline.tracks ?? []).forEach((track, index) => roots.push([`/tracks/${index}/app`, track.app]));
  (timeline.pinnedShotGroups ?? []).forEach((group, groupIndex) => {
    (group.imageClipSnapshot ?? []).forEach((snapshot, snapshotIndex) => {
      roots.push([`/pinnedShotGroups/${groupIndex}/imageClipSnapshot/${snapshotIndex}`, snapshot]);
    });
  });
  for (const [field, value] of roots) {
    if (value !== undefined) rejectUnknownResourceMetadata(value, field);
  }
}

function inspectManifestExtras(manifest) {
  const allowedResourcePointers = [
    /^\/assets\/\d+\/thumbnail(?:_sha256)?$/,
    /^\/assets\/\d+\/video(?:_sha256)?$/,
    /^\/audio$/,
    /^\/project_poster$/,
    /^\/project_poster\/(?:path|sha256)$/,
  ];
  function visit(value, pointer) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      const pointerKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const nestedPointer = `${pointer}/${pointerKey}`;
      if (
        classifyResourceKey(key)
        && nested !== null
        && nested !== ""
        && !allowedResourcePointers.some((pattern) => pattern.test(nestedPointer))
      ) {
        fail(
          "unsupported-resource-kind",
          nestedPointer,
          nested,
          "resource-like manifest metadata is not part of the supported v1 dependency contract",
        );
      }
      visit(nested, nestedPointer);
    }
  }
  visit(manifest, "");
}

function addInventory(inventory, seenPaths, fixtureRoot, entry) {
  const resolved = validateRelativePath(fixtureRoot, entry.path, entry.field);
  const bytes = fs.readFileSync(resolved.absolute);
  const actualHash = sha256(bytes);
  validateSha(entry.expectedSha256, `${entry.field}_sha256`);
  if (actualHash !== entry.expectedSha256) {
    fail("hash-mismatch", entry.field, entry.path, `expected ${entry.expectedSha256}, got ${actualHash}`);
  }
  if (seenPaths.has(resolved.relative)) {
    const previous = seenPaths.get(resolved.relative);
    if (previous.record.sha256 !== actualHash || previous.record.type !== entry.type) {
      fail("conflicting-resource", entry.field, entry.path, `conflicts with ${previous.firstField}`);
    }
    previous.record.references.push(entry.field);
    previous.record.references.sort();
    return;
  }
  const record = {
    path: resolved.relative,
    type: entry.type,
    size_bytes: resolved.size,
    sha256: actualHash,
    references: [entry.field],
  };
  inventory.push(record);
  seenPaths.set(resolved.relative, { record, firstField: entry.field });
}

export function verifyFixture({ fixtureRoot, schemaPath }) {
  const root = fs.realpathSync(path.resolve(fixtureRoot));
  const schemaAbsolute = path.resolve(schemaPath);
  const inputs = [
    ["asset-manifest.json", "manifest"],
    ["project-contract.json", "contract"],
    ["registry-candidate.json", "registry"],
    ["scripted-example.json", "scriptedExample"],
    ["timeline-candidate.json", "timeline"],
  ];
  const loaded = {};
  const inputHashes = [];
  for (const [name, key] of inputs) {
    const parsed = readJson(path.join(root, name), `inputs.${name}`);
    loaded[key] = parsed.value;
    inputHashes.push({ path: name, sha256: sha256(parsed.bytes), size_bytes: parsed.bytes.length });
  }
  const schemaParsed = readJson(schemaAbsolute, "schema");
  inputHashes.push({
    path: path.relative(process.cwd(), schemaAbsolute).replaceAll("\\", "/"),
    sha256: sha256(schemaParsed.bytes),
    size_bytes: schemaParsed.bytes.length,
  });
  inputHashes.sort((a, b) => a.path.localeCompare(b.path));

  const { manifest, contract, registry, scriptedExample, timeline } = loaded;
  assertObject(manifest, "manifest");
  assertObject(contract, "contract");
  assertObject(registry, "registry");
  assertObject(scriptedExample, "scriptedExample");
  assertObject(timeline, "timeline");

  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  const validateTimeline = ajv.compile(schemaParsed.value);
  if (!validateTimeline(timeline)) {
    fail("schema-validation", "timeline-candidate.json", undefined, schemaErrorText(validateTimeline.errors));
  }
  const registrySchema = {
    type: "object",
    properties: {
      assets: {
        type: "object",
        additionalProperties: {
          $ref: "#/definitions/AssetEntry",
        },
      },
    },
    required: ["assets"],
    additionalProperties: false,
    definitions: schemaParsed.value.definitions,
  };
  const validateRegistry = ajv.compile(registrySchema);
  if (!validateRegistry(registry)) {
    fail("schema-validation", "registry-candidate.json", undefined, schemaErrorText(validateRegistry.errors));
  }

  if (!Array.isArray(manifest.assets)) fail("invalid-shape", "manifest.assets", manifest.assets, "expected an array");
  assertObject(contract.assets, "contract.assets");
  assertObject(contract.clips, "contract.clips");
  assertObject(registry.assets, "registry.assets");
  if (!Array.isArray(timeline.clips)) fail("invalid-shape", "timeline.clips", timeline.clips, "expected an array");
  if (!Array.isArray(timeline.tracks)) fail("invalid-shape", "timeline.tracks", timeline.tracks, "expected an array");

  checkUnique(manifest.assets.map((asset) => asset.key), "manifest.assets.key");
  checkUnique(Object.values(contract.assets).map((asset) => asset.id), "contract.assets.id");
  checkUnique(Object.values(contract.clips).map((clip) => clip.id), "contract.clips.id");
  checkUnique(timeline.clips.map((clip) => clip.id), "timeline.clips.id");
  checkUnique(timeline.tracks.map((track) => track.id), "timeline.tracks.id");
  checkUnique((scriptedExample.steps ?? []).map((step) => step.id), "scriptedExample.steps.id");
  inspectManifestExtras(manifest);

  const manifestAssets = new Map(manifest.assets.map((asset) => [asset.key, asset]));
  const manifestKeys = [...manifestAssets.keys()].sort();
  const contractKeys = Object.keys(contract.assets).sort();
  const registryKeys = Object.keys(registry.assets).sort();
  assertEqual(JSON.stringify(contractKeys), JSON.stringify(manifestKeys), "contract.assets", "asset key sets differ from manifest");
  assertEqual(JSON.stringify(registryKeys), JSON.stringify(manifestKeys), "registry.assets", "asset key sets differ from manifest");

  const inventory = [];
  const seenPaths = new Map();
  for (const key of manifestKeys) {
    const manifestAsset = manifestAssets.get(key);
    const contractAsset = contract.assets[key];
    const registryAsset = registry.assets[key];
    assertObject(manifestAsset, `manifest.assets.${key}`);
    assertObject(contractAsset, `contract.assets.${key}`);
    assertObject(registryAsset, `registry.assets.${key}`);
    assertEqual(contractAsset.id, key, `contract.assets.${key}.id`);
    assertEqual(contractAsset.path, manifestAsset.video, `contract.assets.${key}.path`);
    assertEqual(registryAsset.file, manifestAsset.video, `registry.assets.${key}.file`);
    assertEqual(contractAsset.sha256, manifestAsset.video_sha256, `contract.assets.${key}.sha256`);
    assertEqual(registryAsset.content_sha256, manifestAsset.video_sha256, `registry.assets.${key}.content_sha256`);
    assertEqual(contractAsset.duration_seconds, manifestAsset.duration_seconds, `contract.assets.${key}.duration_seconds`);
    assertEqual(registryAsset.duration, manifestAsset.duration_seconds, `registry.assets.${key}.duration`);
    addInventory(inventory, seenPaths, root, {
      path: manifestAsset.video,
      expectedSha256: manifestAsset.video_sha256,
      field: `manifest.assets.${key}.video`,
      type: "video",
    });
    addInventory(inventory, seenPaths, root, {
      path: contractAsset.path,
      expectedSha256: contractAsset.sha256,
      field: `contract.assets.${key}.path`,
      type: "video",
    });
    addInventory(inventory, seenPaths, root, {
      path: registryAsset.file,
      expectedSha256: registryAsset.content_sha256,
      field: `registry.assets.${key}.file`,
      type: "video",
    });
    addInventory(inventory, seenPaths, root, {
      path: manifestAsset.thumbnail,
      expectedSha256: manifestAsset.thumbnail_sha256,
      field: `manifest.assets.${key}.thumbnail`,
      type: "thumbnail",
    });

    for (const remoteField of ["url", "thumbnailUrl", "url_expires_at", "etag"]) {
      if (registryAsset[remoteField] !== undefined) {
        fail(
          "external-resource-metadata",
          `registry.assets.${key}.${remoteField}`,
          registryAsset[remoteField],
          "remote or signed resource metadata is not allowed in this offline fixture",
        );
      }
    }
    for (const providerField of ["media_id", "generationId", "variantId"]) {
      if (registryAsset[providerField] !== undefined) {
        fail(
          "provider-binding-present",
          `registry.assets.${key}.${providerField}`,
          registryAsset[providerField],
          "provider-backed identities must remain unbound for light-study-v1",
        );
      }
    }
  }

  assertObject(manifest.project_poster, "manifest.project_poster");
  addInventory(inventory, seenPaths, root, {
    path: manifest.project_poster.path,
    expectedSha256: manifest.project_poster.sha256,
    field: "manifest.project_poster.path",
    type: "project-poster",
  });

  const trackIds = new Set(timeline.tracks.map((track) => track.id));
  const timelineClipIdSet = new Set(timeline.clips.map((clip) => clip.id));
  let timelineEnd = 0;
  for (const [index, clip] of timeline.clips.entries()) {
    const field = `timeline.clips[${index}]`;
    if (!manifestAssets.has(clip.asset)) fail("unresolved-identity", `${field}.asset`, clip.asset, "clip refers to an unknown asset");
    if (!trackIds.has(clip.track)) fail("unresolved-identity", `${field}.track`, clip.track, "clip refers to an unknown track");
    const contractClip = contract.clips[clip.id];
    if (!contractClip) fail("unresolved-identity", `${field}.id`, clip.id, "clip is absent from project contract");
    assertEqual(contractClip.id, clip.id, `contract.clips.${clip.id}.id`, "contract clip ID differs from its map key/timeline ID");
    assertEqual(contractClip.asset_id, clip.asset, `contract.clips.${clip.id}.asset_id`);
    assertEqual(contractClip.at_seconds, clip.at, `contract.clips.${clip.id}.at_seconds`);
    assertEqual(contractClip.source_start_seconds, clip.from, `contract.clips.${clip.id}.source_start_seconds`);
    assertEqual(contractClip.source_end_seconds, clip.to, `contract.clips.${clip.id}.source_end_seconds`);
    assertFiniteNumber(clip.at, `${field}.at`);
    assertFiniteNumber(clip.from, `${field}.from`);
    assertFiniteNumber(clip.to, `${field}.to`);
    if (clip.from < 0 || clip.to <= clip.from) fail("invalid-range", field, [clip.from, clip.to], "clip source range must be positive");
    const duration = clip.to - clip.from;
    assertEqual(duration, manifestAssets.get(clip.asset).duration_seconds, `${field}.to`, "clip range differs from asset duration");
    timelineEnd = Math.max(timelineEnd, clip.at + duration);
  }
  const timelineClipIds = timeline.clips.map((clip) => clip.id).sort();
  const contractClipIds = Object.keys(contract.clips).sort();
  assertEqual(JSON.stringify(contractClipIds), JSON.stringify(timelineClipIds), "contract.clips", "clip key sets differ from timeline");
  assertEqual(timelineEnd, 28, "timeline.duration_seconds", "fixture must remain an exact 28-second sequence");

  for (const [index, group] of (timeline.pinnedShotGroups ?? []).entries()) {
    const field = `timeline.pinnedShotGroups[${index}]`;
    if (group.trackId !== undefined && !trackIds.has(group.trackId)) {
      fail("unresolved-identity", `${field}.trackId`, group.trackId, "pinned shot group refers to an unknown track");
    }
    for (const [clipIndex, clipId] of (group.clipIds ?? []).entries()) {
      if (!timelineClipIdSet.has(clipId)) {
        fail("unresolved-identity", `${field}.clipIds[${clipIndex}]`, clipId, "pinned shot group refers to an unknown clip");
      }
    }
    if (group.videoAssetKey !== undefined && !manifestAssets.has(group.videoAssetKey)) {
      fail("unresolved-identity", `${field}.videoAssetKey`, group.videoAssetKey, "pinned shot group refers to an unknown asset");
    }
    if ((group.poolGenerationIds ?? []).length > 0) {
      fail(
        "provider-binding-present",
        `${field}.poolGenerationIds`,
        group.poolGenerationIds,
        "provider generation identities must remain unbound for light-study-v1",
      );
    }
  }

  assertEqual(contract.source_manifest, "asset-manifest.json", "contract.source_manifest");
  assertEqual(contract.fixture_version, manifest.fixture_version, "contract.fixture_version");
  assertEqual(scriptedExample.fixture_version, contract.fixture_version, "scriptedExample.fixture_version");
  assertEqual(scriptedExample.logical_key, contract.script?.logical_key, "scriptedExample.logical_key");
  const scriptedAssetIds = scriptedExample.steps?.find((step) => step.id === "source-media")?.asset_ids;
  if (!Array.isArray(scriptedAssetIds)) {
    fail("invalid-shape", "scriptedExample.steps.source-media.asset_ids", scriptedAssetIds, "expected the source-media asset ID list");
  }
  checkUnique(scriptedAssetIds, "scriptedExample.steps.source-media.asset_ids");
  assertEqual(
    JSON.stringify([...scriptedAssetIds].sort()),
    JSON.stringify(manifestKeys),
    "scriptedExample.steps.source-media.asset_ids",
    "scripted asset IDs differ from the contract/manifest asset namespace",
  );
  const scriptedClipIds = new Set();
  const scriptedResultKeys = [];
  for (const [stepIndex, step] of (scriptedExample.steps ?? []).entries()) {
    for (const [clipIndex, clipId] of (step.clip_ids ?? []).entries()) {
      if (!timelineClipIdSet.has(clipId)) {
        fail(
          "unresolved-identity",
          `scriptedExample.steps[${stepIndex}].clip_ids[${clipIndex}]`,
          clipId,
          "scripted example refers to an unknown timeline clip",
        );
      }
      scriptedClipIds.add(clipId);
    }
    if (step.result_logical_key !== undefined) {
      assertEqual(step.result_logical_key, contract.result?.logical_key, `scriptedExample.steps[${stepIndex}].result_logical_key`);
      scriptedResultKeys.push(step.result_logical_key);
    }
  }
  assertEqual(
    JSON.stringify([...scriptedClipIds].sort()),
    JSON.stringify(timelineClipIds),
    "scriptedExample.steps.clip_ids",
    "scripted clip IDs do not cover the contract/timeline clip namespace",
  );
  assertEqual(
    JSON.stringify(scriptedResultKeys),
    JSON.stringify([contract.result?.logical_key]),
    "scriptedExample.steps.result_logical_key",
    "scripted example must declare the contract result logical key exactly once",
  );
  assertEqual(contract.result?.state, "not-produced", "contract.result.state");
  if (Object.hasOwn(contract.result ?? {}, "id")) {
    fail("conflicting-identity", "contract.result.id", contract.result.id, "result ID must remain unbound before a verified export exists");
  }
  if (Object.hasOwn(contract.project ?? {}, "provider_id") || Object.hasOwn(contract.timeline ?? {}, "provider_id")) {
    fail("conflicting-identity", "contract.provider_id", undefined, "provider IDs must remain unbound for this offline fixture");
  }

  inspectOpenSchemaAreas(timeline);
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  inventory.forEach((entry) => entry.references.sort());

  return {
    report_version: 1,
    fixture_version: contract.fixture_version,
    inputs: inputHashes,
    schema_validation: {
      timeline: "pass",
      registry_root_and_asset_entries: "pass",
      schema: "vendor/timeline-schema/python/banodoco_timeline_schema/timeline.schema.json",
      ajv_version: ajvVersion,
    },
    dependency_inspection: {
      supported_kinds: [
        "manifest.asset.thumbnail",
        "manifest.asset.video",
        "manifest.project_poster",
        "project_contract.asset.path",
        "registry.asset.file",
        "timeline.clip.asset",
        "timeline.pinned_shot_group.clip",
        "timeline.pinned_shot_group.track",
        "timeline.pinned_shot_group.video_asset",
      ],
      nested_bundle_effect_dependencies: "not-present-in-fixture; nested closure not exercised",
      unresolved: [],
      unsupported: [],
    },
    inventory,
    totals: {
      duration_seconds: timelineEnd,
      files: inventory.length,
      thumbnails: inventory.filter((entry) => entry.type === "thumbnail").length,
      videos: inventory.filter((entry) => entry.type === "video").length,
      project_posters: inventory.filter((entry) => entry.type === "project-poster").length,
      bytes: inventory.reduce((sum, entry) => sum + entry.size_bytes, 0),
    },
    states: {
      offline_integrity: "pass",
      provider_binding: "unbound",
      exported_package_closure: "not-run",
      result: "not-produced",
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("cli-usage", "arguments", argv, "expected --fixture, --schema and --report values");
    args[name.slice(2)] = value;
  }
  for (const required of ["fixture", "schema", "report"]) {
    if (!args[required]) fail("cli-usage", `arguments.${required}`, undefined, `missing --${required}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = verifyFixture({ fixtureRoot: args.fixture, schemaPath: args.schema });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = path.resolve(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, output);
  process.stdout.write(`offline integrity: ${report.states.offline_integrity}\n`);
  process.stdout.write(`inventory: ${report.totals.files} files (${report.totals.videos} videos, ${report.totals.thumbnails} thumbnails, ${report.totals.project_posters} poster)\n`);
  process.stdout.write(`timeline: ${report.totals.duration_seconds} seconds\n`);
  process.stdout.write(`provider binding: ${report.states.provider_binding}\n`);
  process.stdout.write(`exported package closure: ${report.states.exported_package_closure}\n`);
  process.stdout.write(`result: ${report.states.result}\n`);
  process.stdout.write(`report: ${reportPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof VerificationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
