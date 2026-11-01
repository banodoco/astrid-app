import { useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { Input } from '@/shared/components/ui/input.tsx';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog.tsx';
import { toast } from '@/shared/components/ui/toast.tsx';

/** Renames one chat; `chat` is null while closed. */
export function RenameChatDialog({ chat, onClose, onRename }: {
  chat: { id: string; label: string } | null;
  onClose: () => void;
  onRename: (sessionId: string, title: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Each opening starts from the chat's current name, before the input focuses and selects it.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if ((chat?.id ?? null) !== openedFor) {
    setOpenedFor(chat?.id ?? null);
    if (chat) { setValue(chat.label); setError(null); }
  }

  return (
    <Dialog open={!!chat} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const title = value.trim();
            if (!title) {
              setError('Enter a chat name.');
              return;
            }
            if (title.length > 120) {
              setError('Chat names must be 120 characters or fewer.');
              return;
            }
            if (!chat) return;
            setPending(true);
            setError(null);
            try {
              await onRename(chat.id, title);
              onClose();
            } catch (cause) {
              toast.error(cause instanceof Error ? cause.message : 'Could not rename chat.');
            } finally {
              setPending(false);
            }
          }}
        >
          <DialogHeader><DialogTitle>Rename chat</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Input
              autoFocus
              aria-label="Chat name"
              value={value}
              maxLength={121}
              onFocus={(event) => event.currentTarget.select()}
              aria-invalid={!!error}
              aria-describedby={error ? 'rename-chat-error' : undefined}
              onChange={(event) => { setValue(event.target.value); setError(null); }}
              disabled={pending}
            />
            {error && <p id="rename-chat-error" className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
