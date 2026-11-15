from pathlib import Path
import hashlib

ROOT = Path('.')
def edit(path, sha, replacements):
    p=ROOT/path; raw=p.read_bytes()
    actual=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
    assert actual==sha, (path,actual,sha)
    s=raw.decode()
    for old,new in replacements:
        assert s.count(old)==1, (path,old[:100],s.count(old))
        s=s.replace(old,new,1)
    p.write_text(s)

edit('src/pages/Home/PublicAstridCallouts.tsx','81d1bdd9afccf20b053c696d729f3e63695f066b',[
 ('  useEffect(() => { setOpenId(null); }, [audience, phone]);','  useLayoutEffect(() => { setOpenId(null); }, [audience, phone]);'),
 ('          <div className="astrid-callout-content">\n            <h2>', '''          {/* Slots persist for the position/connector morph. Disclosure DOM belongs to
              its subject: inheriting an outgoing grid-row transition gives another
              slot a temporary expanded destination and a snap at the end. */}
          <div key={callout.id} className="astrid-callout-content">
            <h2>''')])

edit('src/pages/Home/publicAstridNavigation.ts','77fcb5a5cb7733b32c2152991562088dd1dc395e',[
 ("presentation: 'shared' | 'crossfade' = 'shared'", "presentation: 'shared' | 'brand' | 'crossfade' = 'shared'")])
edit('src/pages/Home/PublicAstridSite.tsx','138bf0c26d149a2bf48dfcf8eb635b2bba9377f8',[
 ("    // Off-screen heroes are not useful morphing anchors. Crossfade instead.\n    const presentation = outgoingScroll > 72 || incomingScroll > 72 ? 'crossfade' : 'shared';",'''    // A scrolled Vision header is still a visible brand anchor. On desktop,
    // glide that mink home while the off-screen document content crossfades.
    // Do not restore off-screen hero/label morphs or change scroll ownership.
    const scrolled = outgoingScroll > 72 || incomingScroll > 72;
    const presentation = !scrolled ? 'shared'
      : next === 'home' && incomingScroll <= 72 && !environment.phone ? 'brand' : 'crossfade';'''),
 ("    run(commit, pageRef.current !== next ? next : undefined, presentation);\n  }, [run]);", "    run(commit, pageRef.current !== next ? next : undefined, presentation);\n  }, [run, environment.phone]);")])

p=ROOT/'src/pages/Home/PublicAstridSite.css';raw=p.read_bytes()
assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()=='6d108ffad17937706f5d1226df9d47adecf6dbdc'
s=raw.decode().replace(':root[data-astrid-page-transition-style="crossfade"]', ':root:is([data-astrid-page-transition-style="crossfade"], [data-astrid-page-transition-style="brand"])')
s+='''
/* Keep just the visible mink shared on a scrolled desktop return. Retained
   Home must not acquire the same name before the navigation commit. */
:root[data-astrid-page-transition-style="brand"] .astrid-vision .astrid-vision-brand img,
:root[data-astrid-page-transition-style="brand"] .astrid-public-site[data-astrid-lifecycle="active"] .astrid-brand-mink:not(.astrid-brand-mink-glint) {
  view-transition-name: astrid-brand-mink !important;
}
'''
p.write_text(s)

edit('src/pages/Home/VisionDialog.tsx','98dc9be9b8e1e18b98a50a056dd74c76d898e52e',[
 ("export function VisionDialog(",'''// Use actual gutters, not a guessed device breakpoint. These controls remain
// in the native modal's top layer, including outside its visual surface.
function placeDialogNavigation(dialog: HTMLDialogElement) {
  if (!dialog.open) return;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const right = left + (viewport?.width ?? window.innerWidth);
  const box = dialog.getBoundingClientRect();
  const room = Math.min(box.left - left, right - box.right);
  dialog.toggleAttribute('data-exterior-nav', window.innerWidth > 760 && room >= 72);
}

export function VisionDialog('''),
 ("      dialog.style.setProperty('--vision-viewport-height', (viewport?.height ?? window.innerHeight) + 'px');\n    };", "      dialog.style.setProperty('--vision-viewport-height', (viewport?.height ?? window.innerHeight) + 'px');\n      placeDialogNavigation(dialog);\n    };"),
 ("    update();\n    viewport?.addEventListener('resize', schedule);", "    update();\n    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);\n    observer?.observe(dialog);\n    viewport?.addEventListener('resize', schedule);"),
 ("      if (frame) window.cancelAnimationFrame(frame);\n      viewport?.removeEventListener('resize', schedule);", "      if (frame) window.cancelAnimationFrame(frame);\n      observer?.disconnect();\n      viewport?.removeEventListener('resize', schedule);"),
 ("      dialog.showModal();\n      if (document.activeElement", "      dialog.showModal();\n      placeDialogNavigation(dialog);\n      if (document.activeElement"),
 ("          {(previous || next) && <>", "      </div>\n          {(previous || next) && <>"),
 ("          </>}\n      </div>\n    </dialog>", "          </>}\n    </dialog>")])

p=ROOT/'src/pages/Home/VisionMobileLayout.css';raw=p.read_bytes()
assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()=='bd2ef468e35af09c1a260cea571c11bf4e8e9cc8'
s=raw.decode()
for alpha in ['.36','.25','.65']:
    s=s.replace('opacity: '+alpha+';', 'opacity: calc('+alpha+' * var(--vision-open-progress, 0));')
s+='''
/* The reading surface keeps its width. Wide gutters carry the controls;
   narrower windows keep the established unobtrusive overlay placement. */
.astrid-vision-details[data-exterior-nav] > .astrid-vision-details-previous { left: -60px; }
.astrid-vision-details[data-exterior-nav] > .astrid-vision-details-next { right: -60px; }
.astrid-vision-subject-counts > span:not([aria-hidden]) { white-space: nowrap; }
'''
p.write_text(s)

edit('src/pages/Home/PublicAstridVision.tsx','19cf94ba17fa3ffac67aa9dd7ab949451e1eda24',[
 ('  return <span className="astrid-vision-subject-counts">\n    <span>{gaps}', '  const goals = hierarchy.aspirations.length;\n  return <span className="astrid-vision-subject-counts">\n    <span>{goals} {goals === 1 ? \'goal\' : \'goals\'}</span><span aria-hidden="true"> · </span>\n    <span>{gaps}')])
edit('src/pages/Home/VisionDetailDialog.tsx','372bd2b53426ea47d61e9cf8466e03da54e98be9',[
 ('aria-label="Aspirations"', 'aria-label="Goals"'), ('<h3>Aspirations</h3>', '<h3>Goals</h3>')])

# Update only expectations deliberately superseded by the owner's new labels
# and exterior-arrow placement. Retain the cases, all geometry and interactions.
for p in (ROOT/'tests/e2e').glob('public-astrid-vision-*.spec.ts'):
    s=p.read_text();s=s.replace("name: 'Aspirations'", "name: 'Goals'")
    if p.name=='public-astrid-vision-mobile-catalogs.spec.ts':
        old=".toHaveText(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'} · ${projects} ${projects === 1 ? 'project' : 'projects'}`);"
        assert s.count(old)==2
        s=s.replace(old,".toHaveText(`${hierarchy.aspirations.length} ${hierarchy.aspirations.length === 1 ? 'goal' : 'goals'} · ${gaps} ${gaps === 1 ? 'gap' : 'gaps'} · ${projects} ${projects === 1 ? 'project' : 'projects'}`);")
        old="""        expect(text.x).toBeLessThan((await previous.boundingBox())!.x + 44);
        expect(text.x + text.width).toBeGreaterThan((await next.boundingBox())!.x);"""
        new="""        if (await dialog.evaluate(node => node.hasAttribute('data-exterior-nav'))) {
          const bounds = (await dialog.boundingBox())!;
          const left = (await previous.boundingBox())!;
          const right = (await next.boundingBox())!;
          expect(left.x + left.width).toBeLessThan(bounds.x);
          expect(right.x).toBeGreaterThan(bounds.x + bounds.width);
          expect(left.x).toBeGreaterThanOrEqual(0);
          expect(right.x + right.width).toBeLessThanOrEqual(width);
          expect(text.x).toBeGreaterThan(bounds.x);
          expect(text.x + text.width).toBeLessThan(bounds.x + bounds.width);
        } else {
          expect(text.x).toBeLessThan((await previous.boundingBox())!.x + 44);
          expect(text.x + text.width).toBeGreaterThan((await next.boundingBox())!.x);
        }"""
        assert s.count(old)==1;s=s.replace(old,new)
    if s!=p.read_text():p.write_text(s)

p=ROOT/'src/pages/Home/PublicAstridCallouts.scheduling.test.tsx'
p.write_text(p.read_text()+'''
// Keep slot and connector identity, but not an unrelated subject's disclosure.
it('owns mobile disclosure content by subject across audience changes', () => {
  phone = true;
  const view = render(<Stage audience="app" />);
  const slots = [...document.querySelectorAll('article.astrid-callout')];
  const before = slots.map(slot => slot.querySelector('.astrid-callout-content'));
  fireEvent.click(document.querySelector('[data-callout="effects"] .astrid-callout-toggle')!);
  expect(document.querySelector('[data-callout="effects"]')).toHaveAttribute('data-open', 'true');
  view.rerender(<Stage audience="agent" />);
  expect([...document.querySelectorAll('article.astrid-callout')]).toEqual(slots);
  for (const [index, slot] of slots.entries()) {
    expect(slot.querySelector('.astrid-callout-content')).not.toBe(before[index]);
    expect(slot.querySelector('.astrid-callout-toggle')).toHaveAttribute('aria-expanded', 'false');
  }
  view.rerender(<Stage audience="app" />);
  expect(document.querySelectorAll('article[data-open="true"]')).toHaveLength(0);
});
''')

# Include the nearby Home scheduling regression in the established gate.
p=ROOT/'.github/workflows/public-vision.yml';s=p.read_text()
needle='src/pages/Home/PublicAstridSite.lifecycle.test.tsx src/test/viteShareMeta.test.ts'
assert s.count(needle)==1
s=s.replace(needle,needle+' src/pages/Home/PublicAstridCallouts.scheduling.test.tsx')
p.write_text(s)
