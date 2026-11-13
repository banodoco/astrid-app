from pathlib import Path
import re

ROOT = Path('.')
def read(path): return (ROOT/path).read_text()
def write(path, value):
    p=ROOT/path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(value)
def replace(s, old, new, n=1):
    assert s.count(old) == n, (old[:120], s.count(old), n)
    return s.replace(old,new)

# Extract the proven native-dialog shell without changing its event state machine.
p='src/pages/Home/VisionDetailDialog.tsx'
s=read(p)
start=s.index('export function VisionDetailDialog(')
entry_start=s.index("  const entry = subject.kind === 'pillar'", start)
entry_end=s.index('\n\n  useLayoutEffect', entry_start)
entry=s[entry_start:entry_end]
inner_start=s.index('              {entry.statement', start)
inner_end=s.index('            </div>\n          </div>\n          <div className="astrid-vision-details-scroll-fade', inner_start)
inner=s[inner_start:inner_end]
component=s[start:]
signature=component[:component.index('  const dialogRef')]
generic=replace(component, signature, '''export function VisionDialog({ title, eyebrow, identity, className = '', children, onClose }: {
  title: string;
  eyebrow: string;
  identity: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
}) {
''')
generic=replace(generic,entry,'')
generic=replace(generic,inner,'              {children}\n')
generic=replace(generic,'[content.source.revision, subject.id, subject.kind]','[identity]')
generic=replace(generic,'  if (!entry) return null;\n','')
generic=replace(generic,'className="astrid-vision-details"',"className={'astrid-vision-details ' + className}")
generic=replace(generic,"{subject.kind === 'pillar' ? 'What we’re building towards' : 'The principles that drive us'}",'{eyebrow}')
generic=replace(generic,'{entry.title}','{title}')
write('src/pages/Home/VisionDialog.tsx', "import { useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';\nimport { X } from 'lucide-react';\n\n"+generic)
prefix=s[:start]
prefix=replace(prefix,"import { useLayoutEffect, useId, useRef, useState } from 'react';\n",'')
prefix=replace(prefix,"{ ChevronDown, ExternalLink, X }","{ ChevronDown, ExternalLink }")
prefix="import { VisionDialog } from './VisionDialog';\n"+prefix
write(p,prefix+signature+entry+'''
  if (!entry) return null;
  return (
    <VisionDialog title={entry.title}
      eyebrow={subject.kind === 'pillar' ? 'What we’re building towards' : 'The principles that drive us'}
      identity={content.source.revision + ':' + subject.kind + ':' + subject.id} onClose={onClose}>
'''+inner+'''    </VisionDialog>
  );
}
''')

p='src/pages/Home/PublicAstridVision.tsx'
s=read(p)
s=replace(s,"import { VisionDetailDialog } from './VisionDetailDialog';", "import { VisionDetailDialog } from './VisionDetailDialog';\nimport { VisionDialog } from './VisionDialog';")
s=replace(s,"import type { VisionSubject } from './visionHierarchy';", "import { aspirationsForSubject, type VisionSubject } from './visionHierarchy';\nimport type { PublicVisionContent } from './publicVisionContent';")
s=replace(s,"import './PublicAstridVision.css';", "import './PublicAstridVision.css';\nimport './VisionMobileLayout.css';")
s=replace(s,'This vision is drawn from the','Populated by the',2)
counts='''/** Count exactly the primary groups rendered in the subject popup, including
 * completed work where that popup includes it. Supporting links never duplicate counts. */
function SubjectCounts({ content, subject }: { content: PublicVisionContent; subject: VisionSubject }) {
  const hierarchy = aspirationsForSubject(content, subject);
  const groups = [...hierarchy.aspirations.flatMap(item => item.gaps), ...hierarchy.legacyGaps];
  const gaps = new Set(groups.map(item => item.gap.id)).size;
  const projects = new Set(groups.flatMap(item => item.projects.map(project => project.id))).size;
  return <span className="astrid-vision-subject-counts">
    <span>{gaps} {gaps === 1 ? 'gap' : 'gaps'}</span><span aria-hidden="true"> · </span>
    <span>{projects} {projects === 1 ? 'project' : 'projects'}</span>
  </span>;
}

'''
s=replace(s,'const JUGGLED_ITEMS = [',counts+'const JUGGLED_ITEMS = [')
s=replace(s,"  const [selectedSubject, setSelectedSubject] = useState<VisionSubject | null>(null);", "  const [selectedSubject, setSelectedSubject] = useState<VisionSubject | null>(null);\n  const [selectedCatalog, setSelectedCatalog] = useState<'gaps' | 'projects' | null>(null);")
s=replace(s,'    setSelectedSubject(subject);', '    setSelectedCatalog(null);\n    setSelectedSubject(subject);')
s=replace(s,'    setSelectedSubject(null);','''    setSelectedSubject(null);
    setSelectedCatalog(null);
    if (['#astrid-vision-parts', '#astrid-vision-projects'].includes(window.location.hash)) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }''')
s=replace(s,"  const [agentCopyState, setAgentCopyState]",'''  const openCatalog = (catalog: 'gaps' | 'projects', trigger: HTMLButtonElement) => {
    detailOpenedByPointer.current = lastInteractionWasPointer.current;
    detailTrigger.current = trigger;
    detailScrollY.current = window.scrollY;
    setSelectedSubject(null);
    setGapFilter('all');
    setProjectFilter('all');
    setShowAllGaps(true);
    setShowAllProjects(true);
    setSelectedCatalog(catalog);
  };
  // Old section bookmarks still lead to the corresponding catalog, not a dead anchor.
  useEffect(() => {
    if (!content || !visible) return;
    const followCatalogHash = () => {
      const catalog = window.location.hash === '#astrid-vision-parts' ? 'gaps'
        : window.location.hash === '#astrid-vision-projects' ? 'projects' : null;
      if (!catalog) return;
      detailScrollY.current = window.scrollY;
      detailOpenedByPointer.current = false;
      detailTrigger.current = document.getElementById('astrid-see-all-' + catalog) as HTMLButtonElement | null;
      setSelectedSubject(null);
      setGapFilter('all'); setProjectFilter('all');
      setShowAllGaps(true); setShowAllProjects(true);
      setSelectedCatalog(catalog);
    };
    followCatalogHash();
    window.addEventListener('hashchange', followCatalogHash);
    return () => window.removeEventListener('hashchange', followCatalogHash);
  }, [content, visible]);
  const [agentCopyState, setAgentCopyState]''')
s=replace(s,"gapFilter + ':' + showAllGaps + ':' + projectFilter + ':' + showAllProjects", "gapFilter + ':' + showAllGaps + ':' + projectFilter + ':' + showAllProjects + ':' + selectedCatalog")
s=replace(s,'''<span className="astrid-vision-pillar-details" aria-hidden="true">
                Details <span''','''<span className="astrid-vision-pillar-details">
                <SubjectCounts content={content} subject={{ kind: 'pillar', id: pillar.id }} /> <span''')
s=re.sub(r'          <section className="astrid-vision-loading-group">(?:(?!</section>).)*?astrid-vision-loading-(?:row|projects)(?:(?!</section>).)*?</section>\n', '', s, flags=re.S)
gap_start=s.index('      <section id="astrid-vision-parts"')
project_start=s.index('      <section id="astrid-vision-projects"', gap_start)
end=s.index('      </>)}', project_start)
gaps=s[gap_start:project_start]
projects=s[project_start:end]
for name, section in [('gaps',gaps),('projects',projects)]:
    a=section.index('        <div className="astrid-vision-section-head')
    b=section.index('        </div>\n',a)+len('        </div>\n')
    section=section[:a]+section[b:]
    if name=='gaps': gaps=section
    else: projects=section
gaps=gaps.replace('aria-labelledby="astrid-vision-parts-title"', 'aria-label="Gap catalog"')
projects=projects.replace('aria-labelledby="astrid-vision-projects-title"', 'aria-label="Project catalog"')
s=s[:gap_start]+s[end:]
modal='''      {content && selectedCatalog && (
        <VisionDialog key={selectedCatalog} title={selectedCatalog === 'gaps' ? 'All gaps' : 'All projects'}
          eyebrow="Explore the work" className="astrid-vision-catalog"
          identity={content.source.revision + ':' + selectedCatalog} onClose={closeSubject}>
          {selectedCatalog === 'gaps' ? (
'''+gaps+'''          ) : (
'''+projects+'''          )}
        </VisionDialog>
      )}
'''
s=replace(s,'      {content?.vision.contributeMarkdown && (', modal+'      {content && (')
s=replace(s,'data-index="06">Help us','data-index="04">Help us')
s=replace(s,"            {agentCopyState === 'failed' && (",'''            <div className="astrid-vision-catalog-actions">
              <button id="astrid-see-all-projects" type="button" aria-haspopup="dialog"
                onClick={event => openCatalog('projects', event.currentTarget)}>See all projects <PixelArrow /></button>
              <button id="astrid-see-all-gaps" type="button" aria-haspopup="dialog"
                onClick={event => openCatalog('gaps', event.currentTarget)}>See all gaps <PixelArrow /></button>
            </div>
            {agentCopyState === 'failed' && (''')
s=replace(s,'includeHelp={Boolean(content.vision.contributeMarkdown)}','includeHelp={true}')
write(p,s)
p='src/pages/Home/VisionSectionNav.tsx'
s=read(p)
for row in ["  { id: 'astrid-vision-parts', label: 'Gaps' },\n", "  { id: 'astrid-vision-projects', label: 'Projects' },\n"]: s=replace(s,row,'')
write(p,s)

write('src/pages/Home/VisionMobileLayout.css','''/* The page presents the vision; the full work catalogs are opened on demand. */
.astrid-vision-subject-counts { display: inline-flex; flex-wrap: wrap; gap: 0 4px; }
.astrid-vision .astrid-vision-pillar-details { max-width: 100%; }
.astrid-vision-catalog-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.astrid-vision-catalog-actions button {
  display: inline-flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 44px; padding: 11px 16px; border: 1px solid var(--astrid-line);
  border-radius: 8px; background: var(--astrid-panel); color: var(--astrid-ink);
  font: 500 14px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; cursor: pointer;
}
.astrid-vision-catalog-actions button:hover { border-color: var(--astrid-accent); }
.astrid-vision-catalog-actions button:focus-visible { outline: 2px solid var(--astrid-accent); outline-offset: 3px; }
.astrid-vision-details { max-height: min(94dvh, 1080px); }
.astrid-vision-details-shell { max-height: min(94dvh, 1080px); }
.astrid-vision-catalog { width: min(1120px, calc(100vw - 48px)); }
.astrid-vision-catalog :is(.astrid-vision-parts, .astrid-vision-projects) { width: 100%; margin: 0; padding: 0; }
.astrid-vision-catalog .astrid-vision-context-row { margin-top: 0; }
/* Catalogs scroll inside the native dialog, not on the page's reveal timeline. */
.astrid-vision-catalog [data-reveal] { opacity: 1; transform: none; }
@media (max-width: 760px) {
  .astrid-vision .astrid-vision-principles,
  .astrid-vision .astrid-vision-loading-pillars { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .astrid-vision .astrid-vision-principles > li {
    display: grid; grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 120px auto 1fr auto; gap: 0;
    padding: 12px; min-width: 0;
  }
  .astrid-vision .astrid-vision-principles .astrid-vision-pillar-number { grid-column: 1; grid-row: 1; margin: 0; }
  .astrid-vision .astrid-vision-principles .astrid-vision-pillar-stage {
    grid-column: 1; grid-row: 2; height: 104px; min-height: 0; margin: 6px 0 10px;
    padding: 0; align-self: center; place-items: center;
  }
  .astrid-vision .astrid-vision-principles .astrid-vision-principle-art { --px: 1px; align-self: center; }
  .astrid-vision .astrid-vision-principles h3 {
    grid-column: 1; grid-row: 3; min-width: 0; margin: 0 0 10px;
    font-size: clamp(17px, 4.5vw, 22px); line-height: 1.15; overflow-wrap: anywhere;
  }
  .astrid-vision .astrid-vision-principles li > p { grid-column: 1; grid-row: 4; margin: 0; font-size: 13px; line-height: 1.5; }
  .astrid-vision .astrid-vision-principles .astrid-vision-pillar-details {
    grid-column: 1; grid-row: 5; margin: 14px 0 0; gap: 6px; align-items: flex-end;
  }
  .astrid-vision-subject-counts { gap: 0 3px; }
  .astrid-vision .astrid-vision-standards-list { row-gap: 16px; }
  .astrid-vision > .astrid-vision-details {
    width: 100vw; max-width: 100vw; border-inline-width: 0; border-radius: 10px;
    max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  }
  .astrid-vision-details-shell { max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); }
  .astrid-vision-details-header { padding: 18px max(16px, env(safe-area-inset-right)) 14px max(16px, env(safe-area-inset-left)); }
  .astrid-vision-details-scroll { padding: 16px max(16px, env(safe-area-inset-right)) 20px max(16px, env(safe-area-inset-left)); }
  .astrid-vision-details-close { min-width: 44px; min-height: 44px; }
  .astrid-vision-catalog-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .astrid-vision-catalog-actions button { padding: 12px 10px; gap: 6px; font-size: 13px; text-align: left; }
  .astrid-vision-catalog-actions svg { flex: none; }
}
@media (max-width: 360px) {
  .astrid-vision .astrid-vision-principles > li { padding: 10px; }
  .astrid-vision .astrid-vision-principles .astrid-vision-principle-art { --px: .85px; }
}
''')

# Preserve the list/filter assertions but enter through the new catalog buttons.
helper='''
async function openCatalog(page: import('@playwright/test').Page, kind: 'gaps' | 'projects', current = true) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'See all ' + kind, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'All ' + kind })).toBeVisible();
  if (current) await page.getByRole('combobox', { name: 'Filter ' + kind + ' by status' }).selectOption('current');
}
'''
def edit_test(s, prefix, fn):
    a=s.index("test('"+prefix)
    b=s.find('\ntest(',a+6)
    if b<0:b=len(s)
    return s[:a]+fn(s[a:b])+s[b:]
def after_goto(b, kind, current=True):
    return re.sub(r"(await page.goto\('/vision', \{\s*waitUntil: 'domcontentloaded'\s*\}\);)",r"\1\n  await openCatalog(page, '"+kind+"', "+str(current).lower()+");", b)

p='tests/e2e/public-astrid-vision-content.spec.ts';s=read(p)
s=s.replace("const FEED =",helper+"\nconst FEED =",1)
def desktop(b):
    b=b.replace('  const current = content.gaps',"  await openCatalog(page, 'gaps');\n  const current = content.gaps",1)
    a=b.index('  const catalogLink =');e=b.index('  const gapFilter =',a)
    link_checks=b[a:e];b=b[:a]+b[e:]
    a=b.index('  const gapFilter =');e=b.index("  for (const section of",a);b=b[:a]+b[e:]
    b=b.replace("    const row = page.locator(section", "    await openCatalog(page, section.includes('projects') ? 'projects' : 'gaps');\n    const row = page.locator(section",1)
    a=b.index('  for (const select of [gapFilter, projectFilter]) {')
    b=b[:a]+b[a:].replace('  for (const select of [gapFilter, projectFilter]) {',"  for (const kind of ['gaps', 'projects'] as const) {\n    await openCatalog(page, kind);\n    const select = page.getByRole('combobox', { name: 'Filter ' + kind + ' by status' });",1)
    b=b.replace("  for (const kind of", "  await openCatalog(page, 'projects');\n"+link_checks+"  for (const kind of",1)
    return b
s=edit_test(s,'desktop vision has compact',desktop)
def phone_filters(b):
    return b.replace("      const row = page.locator(section", "      await openCatalog(page, section.includes('projects') ? 'projects' : 'gaps');\n      const row = page.locator(section",1)
s=edit_test(s,'phone status controls',phone_filters)
s=edit_test(s,'every chapter',lambda b:b.replace('toHaveCount(5)','toHaveCount(3)').replace("['\"02\"', '\"03\"', '\"04\"', '\"05\"', '\"06\"']","['\"02\"', '\"03\"', '\"04\"']"))
for title,kind in [('projects filter current','projects'),('phone gap disclosures','gaps'),('project goals show','projects')]:
    s=edit_test(s,title,lambda b,k=kind:after_goto(b,k))
s=edit_test(s,'status filters include',lambda b:after_goto(b,'gaps').replace("  await projectFilter.selectOption('all');","  await openCatalog(page, 'projects', false);\n  await projectFilter.selectOption('all');"))
write(p,s)
p='tests/e2e/public-astrid-vision-mobile-feedback.spec.ts';s=read(p);s=s.replace('const FEED =',helper+'\nconst FEED =',1)
for title in ['mobile gaps start','current gaps show']:s=edit_test(s,title,lambda b:after_goto(b,'gaps'))
write(p,s)
p='tests/e2e/public-astrid-vision-layout-feedback.spec.ts';s=read(p);s=s.replace('const FEED =',helper+'\nconst FEED =',1)
for title,kind in [('desktop shows eight','projects'),('expanded mobile gap','gaps'),('gap IDs remain','gaps')]:s=edit_test(s,title,lambda b,k=kind:after_goto(b,k))
s=edit_test(s,'gap IDs remain',lambda b:b.replace("await page.getByRole('button', {name: 'Show all gaps'}).click();", "if (await page.getByRole('button', {name: 'Show all gaps'}).count()) await page.getByRole('button', {name: 'Show all gaps'}).click();"))
s=s.replace("await expect(page.locator('.astrid-vision-loading-projects .astrid-vision-loading-project')).toHaveCount(9);", "await expect(page.locator('.astrid-vision-loading-projects')).toHaveCount(0);")
write(p,s)
p='tests/e2e/public-astrid-vision-captures.spec.ts';s=read(p)
for size in ['desktop','phone']:
    for kind,selector in [('gaps','.astrid-vision-parts'),('projects','.astrid-vision-projects')]:
        old=f"  await capture(page, '{selector}', '{size}-{kind}.png');"
        new=f"  await page.getByRole('button', {{ name: 'See all {kind}', exact: true }}).click();\n  await expect(page.getByRole('dialog')).toBeVisible();\n  await page.screenshot({{ path: join(folder, '{size}-{kind}.png'), animations: 'disabled' }});\n  await page.keyboard.press('Escape');"
        s=replace(s,old,new)
write(p,s)
p='tests/e2e/public-astrid-vision-sigils-nav.spec.ts';s=read(p)
s=replace(s,'await expect(cue).toHaveText(/Details/i);',"await expect(cue).toHaveText(index < 4 ? /\\d+ gaps?.*\\d+ projects?/i : /Details/i);")
s=replace(s,'const columns = width >= 1180 ? 4 : width > 760 ? 2 : 1;', 'const columns = width >= 1180 ? 4 : 2;')
s=replace(s,'expect(rowCount).toBe(width >= 1180 ? 1 : width > 760 ? 2 : 4);','expect(rowCount).toBe(width >= 1180 ? 1 : 2);')
s=replace(s,'''        expect(item.card.height).toBeLessThan(width <= 640 ? 350 : 430);
        expect(item.art.x).toBeGreaterThanOrEqual(item.heading.x + item.heading.width - 2);
        expect(item.art.x).toBeGreaterThanOrEqual(item.copy.x + item.copy.width - 2);''','''        // Two narrow columns keep the complete copy; art now sits above it.
        expect(item.art.y + item.art.height).toBeLessThanOrEqual(item.heading.y + 1);
        expect(item.art.x).toBeGreaterThanOrEqual(item.card.x);
        expect(Math.abs(item.art.x + item.art.width / 2 - (item.card.x + item.card.width / 2))).toBeLessThan(12);''')
s=s.replace("await expect(nav.getByRole('link')).toHaveCount(6);","await expect(nav.getByRole('link')).toHaveCount(4);")
s=s.replace("      '#astrid-vision-parts', '#astrid-vision-projects', '#astrid-vision-contribute',","      '#astrid-vision-contribute',")
s=s.replace("    ['Gaps', 'astrid-vision-parts'],\n    ['Projects', 'astrid-vision-projects'],\n",'')
s=edit_test(s,'phones get one compact',lambda b:b.replace('/Gaps$/','/Help us$/').replace('astrid-vision-parts','astrid-vision-contribute'))
write(p,s)
p='scripts/quality/check-public-vision-production.mjs';s=read(p)
s=replace(s,"    await expect(page.locator('#gap-aa-001')).toBeAttached();", "    await expect(page.locator('.astrid-vision > #astrid-vision-parts')).toHaveCount(0);\n    await page.getByRole('button', { name: 'See all gaps', exact: true }).click();\n    await expect(page.getByRole('dialog', { name: 'All gaps' })).toBeVisible();\n    await expect(page.locator('#gap-aa-001')).toBeAttached();\n    await page.keyboard.press('Escape');\n    await page.getByRole('button', { name: 'See all projects', exact: true }).click();\n    await expect(page.getByRole('dialog', { name: 'All projects' })).toBeVisible();\n    await expect(page.locator('.astrid-vision-project-row')).toHaveCount(content.projects.length);")
write(p,s)
p='.github/workflows/public-vision.yml';s=read(p)
s=replace(s,'      - "src/pages/Home/VisionDetailDialog.tsx"', '      - "src/pages/Home/VisionDetailDialog.tsx"\n      - "src/pages/Home/VisionDialog.tsx"\n      - "src/pages/Home/VisionMobileLayout.css"\n      - "tests/e2e/public-astrid-vision-mobile-catalogs.spec.ts"')
s=replace(s,'npx eslint src/pages/Home/PublicAstridVision.tsx ', 'npx eslint src/pages/Home/VisionDialog.tsx src/pages/Home/PublicAstridVision.tsx ')
s=replace(s,'tests/e2e/public-astrid-vision-aspirations.spec.ts --project=', 'tests/e2e/public-astrid-vision-aspirations.spec.ts tests/e2e/public-astrid-vision-mobile-catalogs.spec.ts --project=')
write(p,s)
p='playwright.vision.config.ts';s=read(p)
s=replace(s,"testMatch: '**/public-astrid-vision-aspirations.spec.ts',", "testMatch: ['**/public-astrid-vision-aspirations.spec.ts', '**/public-astrid-vision-mobile-catalogs.spec.ts'],")
write(p,s)
print('Applied mobile vision and catalog changes; existing dialog event handling preserved.')
