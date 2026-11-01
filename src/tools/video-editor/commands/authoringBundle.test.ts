// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import type { AuthoredBundle } from '@/tools/video-editor/commands/clipMovePrimitives.ts';
import { authoringBundleFromDocument, type AuthoringBundle } from './authoringBundle.ts';
import fixture from './fixtures/authoringBundle.json';
import correctedFixture from './fixtures/authoringBundleOpaque.json';

/* From App root, check goldens against the actual Python provider/main opener:
 * PYTHONPATH=/path/to/agent-875a9aff-archive /home/user/work/venv-agent/bin/python -c 'from pathlib import Path; exec(Path("src/tools/video-editor/commands/authoringBundle.test.ts").read_text().split("PYTHON_GOLDEN\n")[1].split("\nPYTHON_GOLDEN")[0])'
 * Use Agent 875a9aff4e658def3fa912cacd13f28a911fe89a; append --write to regenerate expected bundles.
 */
type Golden = { name: string; document: CanonicalDocument; bundle: AuthoringBundle };
const goldens = fixture.cases as unknown as Golden[];
const named = (name: string) => goldens.find((golden) => golden.name === name)!;
type ObjectValue = { [key: string]: JSON };
const shared = () => structuredClone(named('repeated-source').document);
const correctedGoldens = correctedFixture.cases as unknown as Golden[];

describe('Agent 875a9aff schema-aware item remap', () => {
  for (const golden of correctedGoldens) {
    it(`matches the complete corrected native bundle: ${golden.name}`, async () => {
      const input = structuredClone(golden.document);
      expect(await authoringBundleFromDocument(input)).toEqual(golden.bundle);
      expect(input).toEqual(golden.document);
      expect(await authoringBundleFromDocument(input)).toEqual(golden.bundle);
    });
  }

  for (const golden of correctedGoldens.filter((entry) => entry.name.startsWith('opaque-'))) {
    it(`preserves foreign item values at every opaque scope: ${golden.name}`, async () => {
      const input = structuredClone(golden.document);
      const source = input.shot_revisions[0].payload;
      const bundle = await authoringBundleFromDocument(input);
      for (const placement of bundle.placements) {
        const owner = placement.shot_id as string;
        const shot = bundle.shots[owner];
        const payload = shot.payload;
        const remap = bundle.source_mapping.shots[owner].item_id_map;
        for (const field of ['data', 'app', 'opaque', 'metadata', 'provenance', 'pools']) {
          expect(payload[field]).toEqual(source[field]);
        }
        const items = payload.items as ObjectValue[];
        const sourceItems = source.items as ObjectValue[];
        for (const [index, item] of items.entries()) {
          const original = sourceItems[index];
          const originalId = (original.item_id ?? original.id) as string;
          const derived = remap[originalId];
          expect(derived).not.toBe(originalId);
          expect(item.item_id ?? item.id).toBe(derived);
          if ('id' in original) {
            expect(item.id).toBe(original.id === originalId ? derived : original.id);
          }
          for (const field of ['data', 'app', 'opaque', 'selected_item_id', 'parent_item_id']) {
            expect(item[field]).toEqual(original[field]);
          }
          const metadata = original.metadata;
          const hasDescriptor = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata);
          const descriptor = hasDescriptor ? item.metadata as ObjectValue : item;
          expect(descriptor.source_item_id).toBe(remap['source-item-a']);
          expect(descriptor.source_item).toBe(remap['source-item-b']);
          if (hasDescriptor) {
            expect((item.metadata as ObjectValue).data).toEqual((metadata as ObjectValue).data);
            expect(item.source_item_id).toBe(original.source_item_id);
          } else {
            expect(item.metadata).toEqual(metadata);
          }
        }
        expect(shot.base_payload).toEqual(payload);
        expect(shot.internal_timeline).toEqual(input.internal_timeline_revisions[0].payload);
      }
      expect(bundle.parent.data).toEqual(input.parent_revision.payload.data);
      expect(bundle.placements[0].data).toEqual((input.parent_revision.payload.occurrences as ObjectValue[])[0].data);
      expect(bundle.source_mapping._runtime_document).toEqual(input);
      expect(input).toEqual(golden.document);
      const [first, sibling] = bundle.placements.map((placement) => placement.shot_id as string);
      expect(bundle.source_mapping.shots[first].item_id_map).not.toEqual(bundle.source_mapping.shots[sibling].item_id_map);
    });
  }
});

describe('Runtime closure → main authoring bundle', () => {
  for (const golden of goldens) {
    it(`matches the complete Python bundle and source mapping: ${golden.name}`, async () => {
      const input = structuredClone(golden.document);
      expect(input).toEqual(correctedGoldens.find((entry) => entry.name === golden.name)!.document);
      const bundle = await authoringBundleFromDocument(input);
      const captureInput: AuthoredBundle = bundle;
      expect(captureInput).toEqual(golden.bundle);
      expect(bundle.source_mapping).toEqual(golden.bundle.source_mapping);
      expect(input).toEqual(golden.document);
      expect(await authoringBundleFromDocument(input)).toEqual(bundle);
    });
  }

  it('snapshots exact input before async hashing and detaches every mutable basis', async () => {
    const golden = named('repeated-source');
    const input = structuredClone(golden.document);
    const pending = authoringBundleFromDocument(input);
    input.parent_revision.payload.unknown = 'changed during load';
    input.shot_revisions[0].payload.items = [];
    const bundle = await pending;
    expect(bundle).toEqual(golden.bundle);
    const first = bundle.placements[0].shot_id as string;
    const sibling = bundle.placements[1].shot_id as string;
    expect(first).not.toBe(sibling);
    // The same raw child clip ID resolves under separate normalized owners.
    (bundle.shots[first].internal_timeline.clips as ObjectValue[])[0].at = 7;
    (bundle.shots[first].payload.items as ObjectValue[])[0].selected_item_id = null;
    bundle.placements[0].duration_ms = 999;
    bundle.parent.bundle = { changed: true };
    expect(bundle.shots[sibling]).toEqual(golden.bundle.shots[sibling]);
    expect(bundle.shots[first].base_internal_timeline).toEqual(golden.bundle.shots[first].base_internal_timeline);
    expect(bundle.shots[first].base_payload).toEqual(golden.bundle.shots[first].base_payload);
    expect(bundle.base_parent_payload).toEqual(golden.bundle.base_parent_payload);
    expect(bundle.base_placements).toEqual(golden.bundle.base_placements);
    expect(bundle.source_mapping).toEqual(golden.bundle.source_mapping);
  });

  it('remaps only Python-known shot item references, preserving opaque strings and internal payloads', async () => {
    const bundle = await authoringBundleFromDocument(shared());
    const owner = bundle.placements[0].shot_id as string;
    const payload = bundle.shots[owner].payload;
    const remap = bundle.source_mapping.shots[owner].item_id_map;
    const items = payload.items as ObjectValue[];
    expect(items[0].item_id).toBe(remap['source-item-a']);
    expect(items[0].selected_item_id).toBe('source-item-b');
    expect(items[1].parent_item_id).toBe('source-item-a');
    expect(payload.related_item_ids).toEqual(['source-item-a', 'unknown-item', { item_id: 'source-item-b' }]);
    expect(payload.bindings).toEqual({ nested: [{ custom_item_id: 'source-item-a' }] });
    expect(payload.opaque).toEqual({ id: 'source-item-a', label: 'source-item-b', values: ['source-item-a'], clear: null });
    expect(bundle.shots[owner].internal_timeline).toEqual(shared().internal_timeline_revisions[0].payload);
    expect(bundle.placements[0]).not.toHaveProperty('shot_revision_id');
    expect(bundle.placements[0]).not.toHaveProperty('revision_id');
    expect(bundle.source_mapping.shots[owner].shot_id).toBe('source-shot');
    expect(bundle.source_mapping._runtime_document).toEqual(shared());
  });

  const invalid: [string, (document: CanonicalDocument) => void, string][] = [
    ['duplicate shot revision', (d) => d.shot_revisions.push(structuredClone(d.shot_revisions[0])), 'duplicate identity'],
    ['duplicate internal revision', (d) => d.internal_timeline_revisions.push(structuredClone(d.internal_timeline_revisions[0])), 'duplicate identity'],
    ['duplicate occurrence', (d) => { const rows = d.parent_revision.payload.occurrences as ObjectValue[]; rows.push(structuredClone(rows[0])); }, 'duplicate identity'],
    ['wrong source shot', (d) => { (d.parent_revision.payload.occurrences as ObjectValue[])[0].shot_id = 'other'; }, 'missing exact occurrence'],
    ['missing shot', (d) => { d.shot_revisions = []; }, 'missing exact occurrence'],
    ['missing internal', (d) => { d.internal_timeline_revisions = []; }, 'missing exact internal'],
    ['contradictory internal link', (d) => { d.shot_revisions[0].payload.internal_timeline_revision_id = 'other'; }, 'link mismatch'],
    ['orphan image', (d) => { d.internal_timeline_revisions.push({ ...d.internal_timeline_revisions[0], revision_id: 'orphan' }); }, 'orphan internal'],
    ['manifest missing image', (d) => { d.dependency_manifest.shots = []; }, 'manifest image mismatch'],
    ['manifest wrong scope', (d) => { d.dependency_manifest.internal_timelines[0].timeline_id = 'other'; }, 'manifest pin mismatch'],
    ['duplicate item', (d) => { const items = d.shot_revisions[0].payload.items as ObjectValue[]; items.push(structuredClone(items[0])); }, 'duplicate identity'],
    ['duplicate fallback item', (d) => { d.shot_revisions[0].payload.items = [{ id: 'legacy-id' }, { id: 'legacy-id' }]; }, 'duplicate identity'],
    ['ambiguous mixed item identity', (d) => { d.shot_revisions[0].payload.items = [{ item_id: 'legacy-id' }, { id: 'legacy-id' }]; }, 'duplicate identity'],
    ['null item collection', (d) => { d.shot_revisions[0].payload.items = null; }, 'expected array'],
    ['duplicate child clip', (d) => { const clips = d.internal_timeline_revisions[0].payload.clips as ObjectValue[]; clips.push(structuredClone(clips[0])); }, 'duplicate identity'],
    ['duplicate track', (d) => { const tracks = (d.parent_revision.payload.config as ObjectValue).tracks as ObjectValue[]; tracks.push(structuredClone(tracks[0])); }, 'duplicate identity'],
  ];
  for (const [name, mutate, message] of invalid) {
    it(`refuses ${name} instead of guessing an owner`, async () => {
      const input = shared();
      mutate(input);
      const before = structuredClone(input);
      await expect(authoringBundleFromDocument(input)).rejects.toThrow(message);
      expect(input).toEqual(before);
    });
  }

  it('refuses collisions between generated owners and raw shot identities', async () => {
    const input = shared();
    const collision = named('repeated-source').bundle.placements[0].shot_id as string;
    const shot = { ...input.shot_revisions[0], shot_id: collision, revision_id: 'collision-revision', payload: { items: [] } };
    input.shot_revisions.push(shot);
    input.dependency_manifest.shots.push({ shot_id: shot.shot_id, revision_id: shot.revision_id,
      internal_timeline_revision_id: shot.internal_timeline_revision_id, content_digest: shot.content_digest });
    (input.parent_revision.payload.occurrences as ObjectValue[]).push({ occurrence_id: 'collision', shot_id: collision, shot_revision_id: shot.revision_id });
    await expect(authoringBundleFromDocument(input)).rejects.toThrow('independent shot identity collision');
  });

  it('remaps valid fallback item IDs deterministically and uniquely per occurrence', async () => {
    const input = shared();
    input.shot_revisions[0].payload.items = [{ id: 'legacy-id' }];
    const before = structuredClone(input);
    const bundle = await authoringBundleFromDocument(input);
    const ids = bundle.placements.map((placement) => {
      const owner = placement.shot_id as string;
      const derived = bundle.source_mapping.shots[owner].item_id_map['legacy-id'];
      expect(derived).toMatch(/^shot-item-placement-[a-f0-9]{64}$/);
      expect(derived).not.toBe('legacy-id');
      expect(bundle.shots[owner].payload.items).toEqual([{ id: derived }]);
      expect(bundle.shots[owner].base_payload.items).toEqual([{ id: derived }]);
      return derived;
    });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await authoringBundleFromDocument(input)).toEqual(bundle);
    expect(bundle.source_mapping._runtime_document).toEqual(before);
    expect(input).toEqual(before);
  });
});

/* PYTHON_GOLDEN
import copy
import hashlib
import json
import sys
from pathlib import Path

from astrid.sdk.timeline.commit import bundle_from_document
from astrid.core.timeline.authoring_bundle import open_authoring_bundle

def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()

def document(shared=False, child=False, unicode=False, fallback=False):
    media = "sha256:" + "a" * 64
    fps = {"numerator": 30000, "denominator": 1001}
    tracks = [{"id": "picture", "kind": "visual", "extension": {"clear": None}}]
    registry = {"assets": {"media": {"object_id": media, "media_type": "video/mp4"}}}
    parent_clip = {"id": "parent-clip", "track": "picture", "at": 1, "hold": 2,
                   "app": {"on": None, "opaque": {"absent_sibling": [None, False, 0]}}}
    parent = {"config": {"output": {"fps": fps}, "tracks": tracks, "clips": [parent_clip]},
              "clips": [parent_clip], "registry": registry, "bundle": None,
              "unknown": {"opaque": [None, {"keep": True}], "number": 1.25}, "occurrences": []}
    internal = {"output": {"fps": fps}, "tracks": tracks, "registry": registry,
                "clips": [{"id": "raw-child-clip", "track": "picture", "asset": "media", "at": 1,
                           "from": 2, "to": 8, "speed": 2,
                           "app": {"on": "source-item-a", "astrid": {"on": None, "opaque": "source-item-a"}}}],
                "bundle": {"source_item_id": "source-item-a", "opaque": None},
                "time_map": None, "extensions": {"item_id": "source-item-b"}}
    payload = {"internal_timeline_revision_id": "internal-r1", "name": "Source shot",
               "items": [{"item_id": "source-item-a", "media_id": media, "selected_item_id": "source-item-b"},
                         {"item_id": "source-item-b", "parent_item_id": "source-item-a", "metadata": None}],
               "bindings": {"nested": [{"custom_item_id": "source-item-a"}]},
               "related_item_ids": ["source-item-a", "unknown-item", {"item_id": "source-item-b"}],
               "opaque": {"id": "source-item-a", "label": "source-item-b", "values": ["source-item-a"], "clear": None}}
    if fallback:
        payload["items"] = [{"id": "legacy-id", "optional": None}]
    shot = {"shot_id": "source-shot", "revision_id": "shot-r1", "internal_timeline_revision_id": "internal-r1",
            "content_digest": digest(payload), "payload": payload}
    internal_image = {"timeline_id": "source-timeline", "revision_id": "internal-r1",
                      "content_digest": digest(internal), "payload": internal}
    if child:
        for index in range(2 if shared else 1):
            occurrence = {"occurrence_id": ("occ:\"é🚀\n" if unicode else "occ-") + str(index),
                          "shot_id": shot["shot_id"], "shot_revision_id": shot["revision_id"],
                          "revision_id": "legacy-occurrence-pin", "placement": {"start_ms": 10000 + index * 20000, "track": "picture"},
                          "duration_ms": 10000, "source_offset": 0, "speed": 1,
                          "transform": None, "provenance": {"id": "source-item-a"}, "opaque": [None, "source-shot"]}
            parent["occurrences"].append(occurrence)
    return {"schema_version": 1, "project_id": "project-\"é🚀" if unicode else "project-main",
            "timeline_id": "timeline:\nmain" if unicode else "timeline-main",
            "parent_revision": {"revision_id": "parent-r1", "content_digest": digest(parent), "payload": parent},
            "shot_revisions": [shot] if child else [], "internal_timeline_revisions": [internal_image] if child else [],
            "dependency_manifest": {
                "shots": [{key: shot[key] for key in ("shot_id", "revision_id", "internal_timeline_revision_id", "content_digest")}] if child else [],
                "internal_timelines": [{key: internal_image[key] for key in ("timeline_id", "revision_id", "content_digest")}] if child else [],
                "media": [{"media_id": media, "content_digest": media}],
                "documents": [{"document_id": "settings:exact", "version": 7, "content_digest": digest({"clear": None})}]}}

cases = []
for name, options in [("parent-only", {}), ("trimmed-child", {"child": True}),
                      ("repeated-source", {"child": True, "shared": True}),
                      ("unicode-identities", {"child": True, "shared": True, "unicode": True}),
                      ("fallback-item-id", {"child": True, "fallback": True})]:
    source = document(**options)
    before = copy.deepcopy(source)
    bundle = bundle_from_document(source)
    direct = open_authoring_bundle(
        {**source["parent_revision"], "project_id": source["project_id"], "timeline_id": source["timeline_id"]},
        shot_revisions=[{**row, "project_id": source["project_id"]} for row in source["shot_revisions"]],
        internal_timeline_revisions=[{**row, "project_id": source["project_id"]} for row in source["internal_timeline_revisions"]])
    direct["source_mapping"]["_runtime_document"] = source
    assert bundle == direct and source == before
    cases.append({"name": name, "document": source, "bundle": bundle})
path = Path("src/tools/video-editor/commands/fixtures/authoringBundle.json")
encoded = json.dumps({"cases": cases}, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
if "--write" in sys.argv:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded)
else:
    assert path.read_text() == encoded, "Python goldens changed; review and regenerate with --write"
print(f"Python golden exact check: {len(cases)} complete closures/bundles passed")
PYTHON_GOLDEN */

/* PYTHON_OPAQUE_GOLDEN
# Export using the exact read-only Agent 875a9aff4e658def3fa912cacd13f28a911fe89a source:
# PYTHONPATH=<Agent source> /home/user/work/venv-agent/bin/python -c 'from pathlib import Path; exec(Path("src/tools/video-editor/commands/authoringBundle.test.ts").read_text().split("PYTHON_OPAQUE_GOLDEN\n")[1].split("\nPYTHON_OPAQUE_GOLDEN")[0])'
# Append --write to regenerate; original fixture INPUTS are kept unchanged.
import copy
import hashlib
import json
import sys
from pathlib import Path

from astrid.sdk.timeline.commit import bundle_from_document
from astrid.core.timeline.authoring_bundle import open_authoring_bundle

def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()

root = Path("src/tools/video-editor/commands/fixtures")
originals = json.loads((root / "authoringBundle.json").read_text())["cases"]
sources = [(case["name"], copy.deepcopy(case["document"])) for case in originals]
shared = next(case["document"] for case in originals if case["name"] == "repeated-source")
opaque = {"org.example.notes/v1": {
    "foreign_item_id": "source-item-a", "foreign_item_ids": ["source-item-a", None, "source-item-b"],
    "item_id": "source-item-a", "source_item_id": "source-item-b", "source_item": "source-item-a",
    "selected_item_id": "source-item-a", "parent_item_id": "source-item-b",
    "nested": [{"foreign_item_id": "source-item-a"}, None], "source-item-a": None,
}}
for codec, location in (("item_id", "metadata"), ("id", "root"),
                        ("both", "null"), ("opaque-id", "array")):
    source = copy.deepcopy(shared)
    payload = source["shot_revisions"][0]["payload"]
    for row in (source["parent_revision"]["payload"], payload,
                source["internal_timeline_revisions"][0]["payload"],
                *source["parent_revision"]["payload"]["occurrences"]):
        for field in ("data", "app", "opaque"):
            row[field] = copy.deepcopy(opaque)
    for field in ("metadata", "provenance", "pools"):
        payload[field] = copy.deepcopy(opaque) if field != "pools" else [copy.deepcopy(opaque)]
    for item in payload["items"]:
        if codec in ("id", "both", "opaque-id"):
            item["id"] = item["item_id"] if codec != "opaque-id" else "opaque-identity"
        if codec == "id":
            del item["item_id"]
        for field in ("data", "app", "opaque"):
            item[field] = copy.deepcopy(opaque)
        item["source_item_id"] = "source-item-a"
        item["source_item"] = "source-item-b"
        item["metadata"] = {"data": copy.deepcopy(opaque), "source_item_id": "source-item-a",
                            "source_item": "source-item-b"}
        if location == "root":
            del item["metadata"]
        elif location == "null":
            item["metadata"] = None
        elif location == "array":
            item["metadata"] = [copy.deepcopy(opaque)]
    for image in (source["parent_revision"], *source["shot_revisions"], *source["internal_timeline_revisions"]):
        image["content_digest"] = digest(image["payload"])
    source["dependency_manifest"]["shots"][0]["content_digest"] = source["shot_revisions"][0]["content_digest"]
    source["dependency_manifest"]["internal_timelines"][0]["content_digest"] = source["internal_timeline_revisions"][0]["content_digest"]
    sources.append((f"opaque-{codec}-{location}", source))

cases = []
for name, source in sources:
    before = copy.deepcopy(source)
    bundle = bundle_from_document(source)
    direct = open_authoring_bundle(
        {**source["parent_revision"], "project_id": source["project_id"], "timeline_id": source["timeline_id"]},
        shot_revisions=[{**row, "project_id": source["project_id"]} for row in source["shot_revisions"]],
        internal_timeline_revisions=[{**row, "project_id": source["project_id"]} for row in source["internal_timeline_revisions"]])
    direct["source_mapping"]["_runtime_document"] = source
    assert bundle == direct and source == before
    cases.append({"name": name, "document": source, "bundle": bundle})
path = root / "authoringBundleOpaque.json"
encoded = json.dumps({"agent_source": "875a9aff4e658def3fa912cacd13f28a911fe89a", "cases": cases},
                     ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
if "--write" in sys.argv:
    path.write_text(encoded)
else:
    assert path.read_text() == encoded, "Corrected native goldens changed; review before regenerating"
print(f"Agent 875a9aff exact native check: {len(cases)} complete closures/bundles passed")
PYTHON_OPAQUE_GOLDEN */
