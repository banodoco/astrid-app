"""Exercise ripple and dry reflow without hiding a separate last-shot overrun.

The first occurrence deliberately ends before its last picture. Reflow must
preserve that overrun and every clip span, without changing occurrence durations.
"""
import copy, importlib.util, json, subprocess, tempfile
from pathlib import Path
from types import SimpleNamespace
from runtime_protocol.service import RuntimeService
from runtime_protocol.store import RealmStore
from runtime_protocol.timeline_commit_port import route_path
from astrid.sdk.timeline import commit
from astrid.sdk.timeline.commit import bundle_from_document
from astrid.sdk.timeline.native_source_inputs import read_verified_transcript
from astrid.sdk.timeline.validation import validate_final_candidate
from astrid.sdk.timeline_checkout import Checkout
base=Path(__file__).resolve().parent

with tempfile.TemporaryDirectory() as d:
 root=Path(d); RealmStore.initialize(d).close(); service=RuntimeService(d); service.register_timeline_commit_provider(commit.create_runtime_commit_service())
 project=service.create_project({'slug':'fixture','name':'Fixture'},idempotency_key='project')['id']
 for args in [ ['-f','lavfi','-i','color=red:s=32x32','-frames:v','1',str(root/'i.png')], ['-f','lavfi','-i','testsrc2=s=32x32:r=1:d=90','-c:v','libx264','-pix_fmt','yuv420p',str(root/'v.mp4')], ['-f','lavfi','-i','sine=duration=90',str(root/'a.wav')]]:
  subprocess.run(['ffmpeg','-loglevel','error','-threads','1','-y',*args],check=True)
 class T:
  def import_project_media(self,p,b,filename,**kw): return service.import_media(p,b,original_name=filename,actor_id='author',**kw)
  def get_project_media_selection(self,p,s): return service.get_project_media_selection(p,s,authorize=lambda:None)
  def get_project_verified_media(self,p,s): return service.get_project_verified_media(p,s,authorize=lambda:None)
  def import_timeline(self,*a,**kw): return service.import_timeline(*a,**kw)
  def get_project_timeline_verified_head(self,p,t): return service.get_timeline_verified_head(p,t,authorize=lambda:None)
  def get_document(self,*a): return service.get_document(*a)
  def get_project_verified_document(self,p,pin): return service.get_project_verified_document(p,pin,authorize=lambda:None)
  def commit_timeline(self,p,t,b,**kw): return service.commit_timeline(p,t,b,publisher='author',invocation_path=route_path(p,t),authorize=lambda:None,**kw)
 shape=json.loads(subprocess.check_output(['node','--input-type=module','-e',f"import {{filmShape}} from '{(base/'film-shape.mjs').as_uri()}';let s=filmShape({{clipCount:621,ripple:true}});s.elements=s.elements.slice(0,1);console.log(JSON.stringify(s));"],text=True))
 spec=importlib.util.spec_from_file_location('film_builder',base/'film_builder.py'); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
 cfg={'project_id':project,'timeline_id':'test-film','clip_target':621,'shape':shape,'node':'node','film_import_module':(base/'film-import.mjs').as_uri(),'media':{'image':[str(root/'i.png')],'video':[str(root/'v.mp4')],'audio':[str(root/'a.wav')]}}
 result=mod.build(cfg,SimpleNamespace(_remote=SimpleNamespace(_transport=T())))
 assert result['accepted_head']['revision_id'] and result['accepted_head']['publication_id']
 assert [row['status'] for row in result['targets']] == ['resolved','resolved','ambiguous','ambiguous']
 assert [row['kind'] for row in result['targets'][:2]] == ['image','video']
 assert result['measurements']['shots'] == 46 and result['render_verified'] is False
 commits, _ = service._timeline_commits()
 closure = commits.revision_closure(project, 'test-film', result['accepted_head']['revision_id'])
 expected_output = {'resolution': '32x32', 'fps': 30, 'file': 'output.mp4'}
 assert closure['parent_revision']['payload']['config']['output'] == expected_output
 assert all(row['payload']['output'] == expected_output for row in closure['internal_timeline_revisions'])
 # A 15-frame cut lies between two source narration segments and words.
 baseline = bundle_from_document(closure)
 capture = read_verified_transcript(T(), project, result['transcript_pin'])
 baseline['source_mapping']['pinned_documents'] = [capture]
 # A separate negative fixture places a repeated declaration in the edited
 # occurrence to prove that an ambiguous changed target is refused.
 negative_baseline = copy.deepcopy(baseline)
 first = baseline['shots']['test-film-shot-0001']['internal_timeline']['clips']
 before = first
 by_id = {c['id']: c for c in before}
 assert by_id['narration']['at'] + by_id['narration']['hold'] <= 0.2
 assert by_id['narration-later']['at'] >= 0.7
 assert by_id['footage-1-1']['at'] >= 0.7
 # A uniquely anchored clip moved alone must be refused with actionable
 # guidance, and validation must not alter the rejected candidate.
 from astrid.core.timeline.authoring_bundle import AuthoringBundleError
 from astrid.sdk.timeline._timing_evaluators import SHOT_WORD_ALTERNATIVE
 def refused_without_mutation(candidate, source):
  snapshot = copy.deepcopy(candidate)
  try:
   validate_final_candidate(candidate, baseline=source)
  except AuthoringBundleError as exc:
   assert SHOT_WORD_ALTERNATIVE in str(exc), str(exc)
  else:
   raise AssertionError('unsafe word retime was accepted')
  assert candidate == snapshot
 alone = copy.deepcopy(baseline)
 alone_clips = {c['id']: c for c in alone['shots']['test-film-shot-0001']['internal_timeline']['clips']}
 alone_clips['footage-1-1']['at'] -= 0.5
 refused_without_mutation(alone, baseline)
 # This independent negative retains the two repeated-word declarations and
 # moves a repeat target with its narration: ambiguity must still refuse it.
 ambiguous = copy.deepcopy(negative_baseline)
 ambiguous_clips = {c['id']: c for c in ambiguous['shots']['test-film-shot-0000']['internal_timeline']['clips']}
 ambiguous_clips['footage-0-2']['at'] += 0.5
 ambiguous_clips['repeat-narration']['at'] += 0.5
 refused_without_mutation(ambiguous, negative_baseline)
 def clip_spans(bundle):
  spans = {('parent', clip['id']): (clip['at'], clip['at'] + clip['hold'])
           for clip in bundle['parent']['clips']}
  for placement in bundle['placements']:
   shot_id = placement['shot_id']
   offset = placement['placement']['start_ms'] / 1000
   for clip in bundle['shots'][shot_id]['internal_timeline']['clips']:
    key = (placement['occurrence_id'], clip['id'])
    assert key not in spans
    spans[key] = (offset + clip['at'], offset + clip['at'] + clip['hold'])
  return spans
 baseline_spans = clip_spans(baseline)
 assert len(baseline_spans) == 621
 checkout = Checkout(copy.deepcopy(baseline))
 checkout._scene_client = T()
 checkout._scene_project = project
 assert abs(checkout.ripple_delete(4.4, 4.9) - 0.5) < 1e-6
 candidate = checkout.bundle
 ripple_spans = clip_spans(candidate)
 assert ripple_spans.keys() == baseline_spans.keys()
 intersecting = []
 for key, (start, end) in baseline_spans.items():
  new_start, new_end = ripple_spans[key]
  if start >= 4.9 - 1e-6:
   assert abs(new_start - (start - 0.5)) < 1e-6 and abs(new_end - (end - 0.5)) < 1e-6, (key, (start, end), ripple_spans[key])
  elif end <= 4.4 + 1e-6:
   assert abs(new_start - start) < 1e-6 and abs(new_end - end) < 1e-6, (key, (start, end), ripple_spans[key])
  else:
   intersecting.append(key)
 assert intersecting == [('parent', 'element-built-in')], intersecting
 after = {c['id']: c for c in candidate['shots']['test-film-shot-0001']['internal_timeline']['clips']}
 for cid in ('narration-later', 'footage-1-1'):
  assert abs(after[cid]['at'] - (by_id[cid]['at'] - 0.5)) < 1e-6, (cid, by_id[cid], after[cid], candidate['placements'][1])
 validate_final_candidate(candidate, baseline=baseline)
 before_reflow = copy.deepcopy(candidate)
 before_spans = clip_spans(before_reflow)
 assert len(before_spans) == 621
 messages = checkout.reflow()
 after_reflow = checkout.bundle
 assert clip_spans(after_reflow) == before_spans
 before_overrun = before_reflow['placements'][0]
 after_overrun = after_reflow['placements'][0]
 assert before_overrun['occurrence_id'] == after_overrun['occurrence_id'] == 'test-film-occ-0'
 assert before_overrun['placement']['start_ms'] == after_overrun['placement']['start_ms'] == 0
 assert before_overrun['duration_ms'] == after_overrun['duration_ms'] == 4100
 def overrun(bundle):
  placement = bundle['placements'][0]
  shot = bundle['shots'][placement['shot_id']]['internal_timeline']
  return max(c['at'] + c['hold'] for c in shot['clips']) > placement['duration_ms'] / 1000
 assert overrun(before_reflow) and overrun(after_reflow)
 duration_changes = [(before['occurrence_id'], before['duration_ms'], after['duration_ms'])
                     for before, after in zip(before_reflow['placements'], after_reflow['placements'])
                     if before['duration_ms'] != after['duration_ms']]
 assert duration_changes == []
 def differences(a, b, path=''):
  if isinstance(a, dict) and isinstance(b, dict):
   for key in a.keys() | b.keys():
    if key not in a or key not in b: print('DIFF', path, key, 'missing')
    else: differences(a[key], b[key], f'{path}/{key}')
  elif isinstance(a, list) and isinstance(b, list):
   if len(a) != len(b): print('DIFF', path, 'length', len(a), len(b))
   for i, (x, y) in enumerate(zip(a, b)): differences(x, y, f'{path}/{i}')
  elif a != b: print('DIFF', path, repr(a), repr(b))
 differences(before_reflow, after_reflow)
 assert after_reflow == before_reflow
 print('reflow messages:', messages, 'overrun durations:', before_overrun['duration_ms'], after_overrun['duration_ms'])
 print('film builder accepted in disposable embedded Runtime; ripple and reflow proved')
