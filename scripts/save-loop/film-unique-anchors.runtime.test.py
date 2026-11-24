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
spec=importlib.util.spec_from_file_location('film_builder',base/'film_builder.py'); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
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
 shape=json.loads(subprocess.check_output(['node','--input-type=module','-e',f"import {{filmFixtureShape}} from '{(base/'film-shape.mjs').as_uri()}';let s=filmFixtureShape(621);console.log(JSON.stringify(s));"],text=True))
 cfg={'project_id':project,'timeline_id':'test-film','clip_target':621,'shape':shape,'node':'node','film_import_module':(base/'film-import.mjs').as_uri(),'omit_ambiguous_anchors':True,'media':{'image':[str(root/'i.png')],'video':[str(root/'v.mp4')],'audio':[str(root/'a.wav')]}}
 result=mod.build(cfg,SimpleNamespace(_remote=SimpleNamespace(_transport=T())))
 assert result['accepted_head']['revision_id'] and result['accepted_head']['publication_id']
 assert [row['status'] for row in result['targets']] == ['resolved','resolved']
 assert [row['kind'] for row in result['targets']] == ['image','video']
 assert result['omitted_ambiguous_anchors'] == 2
 assert result['measurements']['shots'] == 46 and result['render_verified'] is False
 assert result['measurements']['child_clips'] + result['measurements']['parent_clips'] == 621
 commits, _ = service._timeline_commits()
 closure = commits.revision_closure(project, 'test-film', result['accepted_head']['revision_id'])
 opened = mod.data(service.get_timeline_verified_head(project, 'test-film', authorize=lambda:None))
 document = opened['canonical_document']
 assert result['transcript_pin'] in document['dependency_manifest']['documents']
 bundle = bundle_from_document(document)
 parent = next(row for row in bundle['parent']['clips'] if row['id'] == 'element-built-in')
 assert parent['app']['astrid']['word_anchors']['on']['document'] == result['transcript_pin']
 unique = {row['id']: row for row in bundle['shots']['test-film-shot-0001']['internal_timeline']['clips']}
 repeats = {row['id']: row for row in bundle['shots']['test-film-shot-0000']['internal_timeline']['clips']}
 assert [unique[f'footage-1-{i}']['app']['astrid']['on'] for i in range(2)] == ['"w0001"', '"w0002"']
 assert all('on' not in repeats[f'footage-0-{i}'].get('app', {}).get('astrid', {}) for i in (2, 3))
 expected_output = {'resolution': '32x32', 'fps': 30, 'file': 'output.mp4'}
 assert closure['parent_revision']['payload']['config']['output'] == expected_output
 assert all(row['payload']['output'] == expected_output for row in closure['internal_timeline_revisions'])
 print('unique-anchor film builder accepted in disposable embedded Runtime')
