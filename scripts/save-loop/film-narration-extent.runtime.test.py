"""Prove the public-style ripple and reflow preserve the narration fixture.

Runs entirely in a disposable embedded Runtime with generated media.
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
 for args in [ ['-f','lavfi','-i','color=red:s=32x32','-frames:v','1',str(root/'i.png')], ['-f','lavfi','-i','testsrc2=s=32x32:r=1:d=200','-c:v','libx264','-pix_fmt','yuv420p',str(root/'v.mp4')], ['-f','lavfi','-i','sine=duration=200',str(root/'a.wav')]]:
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
 shape=json.loads(subprocess.check_output(['node','--input-type=module','-e',f"import {{filmFixtureShape}} from '{(base/'film-shape.mjs').as_uri()}';let s=filmFixtureShape(23);console.log(JSON.stringify(s));"],text=True))
 spec=importlib.util.spec_from_file_location('film_builder',base/'film_builder.py'); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
 cfg={'project_id':project,'timeline_id':'test-film','clip_target':23, 'omit_ambiguous_anchors': True,'shape':shape,'node':'node','film_import_module':(base/'film-import.mjs').as_uri(),'media':{'image':[str(root/'i.png')],'video':[str(root/'v.mp4')],'audio':[str(root/'a.wav')]}}
 result=mod.build(cfg,SimpleNamespace(_remote=SimpleNamespace(_transport=T())))

 assert result['accepted_head']['revision_id']
 commits, _ = service._timeline_commits()
 closure = commits.revision_closure(project, 'test-film', result['accepted_head']['revision_id'])
 baseline = bundle_from_document(closure)
 capture = read_verified_transcript(T(), project, result['transcript_pin'])
 baseline['source_mapping']['pinned_documents'] = [capture]
 content = capture['document']['content']
 transcript_end = max(segment['end'] for segment in content['segments'])
 audio_clips = [clip for placement in baseline['placements']
                for clip in baseline['shots'][placement['shot_id']]['internal_timeline']['clips']
                if clip['clipType'] == 'audio']
 assert audio_clips
 assert all(clip['to'] <= transcript_end + 1e-9 for clip in audio_clips), (transcript_end, audio_clips)
 checkout = Checkout(copy.deepcopy(baseline)); checkout._scene_client = T(); checkout._scene_project = project
 checkout.ripple_delete(4.4, 4.9)
 candidate = checkout.bundle
 validate_final_candidate(candidate, baseline=baseline)
 def spans(bundle):
  rows = {('parent',c['id']):(c['at'],c['at']+c['hold']) for c in bundle['parent']['clips']}
  for p in bundle['placements']:
   off=p['placement']['start_ms']/1000
   for c in bundle['shots'][p['shot_id']]['internal_timeline']['clips']:
    rows[(p['occurrence_id'],c['id'])]=(off+c['at'],off+c['at']+c['hold'])
  return rows
 before=copy.deepcopy(candidate); a=spans(before)
 from astrid.sdk.timeline import Timeline
 session=SimpleNamespace(client=SimpleNamespace(_remote=SimpleNamespace(_transport=T())), project_id=project, timeline_id='test-film', identity={'realm_id':'disposable'})
 timeline=Timeline(session,copy.deepcopy(before),result['accepted_head'],evaluating=True)
 messages=timeline.reflow(); timeline._capture_free_edits(); after=timeline.bundle; b=spans(after)
 print('reflow messages:', messages)
 for p in after['placements']:
  if p['occurrence_id'].endswith('occ-1'):
   clip=next(c for c in after['shots'][p['shot_id']]['internal_timeline']['clips'] if c['id']=='narration-later')
   assert clip['at']+clip['hold'] <= p['duration_ms']/1000+1e-9
   assert max(c['at'] + c['hold'] for c in after['shots'][p['shot_id']]['internal_timeline']['clips']) <= p['duration_ms']/1000+1e-9
 assert a==b and len(a)==23
 assert before['placements'][1]['duration_ms'] == 191267
 assert after['placements'][1]['duration_ms'] == 700
 assert len(timeline._commands) == 1 and timeline._commands[0]['op'] == 'doc.patch'
 validate_final_candidate(timeline._execution_bundle(after),baseline=before)
 print('23 clips unchanged by public-style reflow; candidate validated; transcript covers narration')
