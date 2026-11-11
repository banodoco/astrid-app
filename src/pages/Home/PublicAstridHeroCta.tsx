import { ArrowRight } from 'lucide-react';
import { APP_ENTRY_PATH, rememberAppEntryPreference } from '@/app/entryClassification.ts';
import { isMobileDevice } from './installScenario.ts';

/**
 * The one call to action: visit the demo. A quiet note beside it says the thing a polished page leaves
 * people unsure of, that Astrid is free to run on their own machine. The stylesheet sets the note beside
 * the label in a wide button and under it in a narrow one.
 */
export function PublicAstridHeroCta({ active = true }: { active?: boolean }) {
  return (
    <div className="astrid-hero-cta">
      <a className="astrid-button astrid-button-primary" href={APP_ENTRY_PATH}
        data-active={active} aria-hidden={!active} tabIndex={active ? undefined : -1}
        onClick={() => { if (!isMobileDevice()) rememberAppEntryPreference(); }}>
        <span className="astrid-cta-label">Visit demo</span>{' '}
        <span className="astrid-cta-note">Free to run locally</span>
        <ArrowRight size={17} aria-hidden="true" />
      </a>
    </div>
  );
}
