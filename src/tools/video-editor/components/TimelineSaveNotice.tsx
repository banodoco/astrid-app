import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/shared/components/ui/alert-dialog.tsx';
import { Button } from '@/shared/components/ui/button.tsx';
import { useTimelineChromeContext } from '../hooks/timelineStore.ts';
import { SaveBar } from './SaveBar.tsx';

export function TimelineSaveNotice() {
  const chrome = useTimelineChromeContext();
  const [confirmExportReload, setConfirmExportReload] = useState(false);
  if (!chrome.saveNotice && !chrome.permanentSaveRejection) return null;
  const bar = chrome.saveBar ?? {
    kind: 'refused' as const,
    headline: chrome.saveNotice ?? 'This timeline change could not be saved.',
    action: 'pending' as const,
  };

  return (
    <>
      <SaveBar bar={bar} className="border-destructive/40 bg-destructive/10 text-destructive"
        children={<span>{chrome.saveNotice ?? bar.headline}</span>}
        actions={chrome.permanentSaveRejection ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => {
              void chrome.copyRejectedSave().then(started => { if (started) setConfirmExportReload(true); });
            }}>
              Copy my change out
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => {
              chrome.cancelRejectedSaveCopy?.();
              void chrome.reloadFromServer({ discardRefusedSave: true }).catch(() => {});
            }}>
              Discard and reload the saved version
            </Button>
          </div>
        ) : undefined} />
      <AlertDialog open={confirmExportReload && chrome.permanentSaveRejection} onOpenChange={setConfirmExportReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep a copy of your unsaved change</AlertDialogTitle>
            <AlertDialogDescription>
              Astrid started a JSON file download containing your original rejected change and all edits built on it.
              Check that the file is safely stored before you continue. Reloading the saved version removes these
              unsaved edits from the editor; they stay in your downloaded file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={chrome.cancelRejectedSaveCopy}>Keep my unsaved edits</AlertDialogCancel>
            <AlertDialogAction onClick={() => void chrome.reloadFromServer({ discardRefusedSave: true }).catch(() => {})}>
              I saved the file — reload the saved version
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
