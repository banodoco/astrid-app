/**
 * The one table of in-app update reasons and their lines. `client.ts` re-exports it; it lives in its own module so
 * surfaces whose tests replace the runtime client still read these exact lines instead of keeping a copy.
 */

/** The first release that can update itself from the App (it reports `self_update`). */
export const FIRST_SELF_UPDATE_RELEASE = 10;

/** Editor-owned reason keys. Runtime refusal codes map to their own key; any other code reads as self-update-unavailable. */
export type InstallerUpdateReason = 'busy' | 'autostart-off' | 'unsupported-service-manager' | 'source' | 'recovery-needed' | 'needs-repair' | 'windows-upgrade-unsupported' | 'self-update-too-old' | 'self-update-unavailable' | 'legacy-update-record' | 'acknowledgement-unknown';

/** Exact editor-owned explanations for the Runtime's allowlisted refusal states. */
export const INSTALLER_UPDATE_REASON_MESSAGES: Readonly<Record<InstallerUpdateReason, string>> = Object.freeze({
  busy: 'Astrid is busy. Wait for the current operation to finish before trying again.',
  'autostart-off': 'Start at sign-in is off, so update from a terminal. This command updates Astrid and starts it; your choice stays off.',
  'unsupported-service-manager': 'In-app updates require user systemd 254 or newer on Linux.',
  'recovery-needed': 'Astrid needs recovery. Select Update to check the previous operation before continuing.',
  'needs-repair': 'Astrid needs repair before it can update.',
  // No command can do this update yet, so there is no retry: the diagnostics file is the one next action.
  'windows-upgrade-unsupported': "Updating from an earlier Windows version of Astrid isn't supported yet, so there is no command to run. Your projects are safe. Download diagnostics and send the file to support.",
  source: 'This Astrid runs from source, so update those checkouts to their main branches and restart Astrid.',
  // What happened (the installed release is too old for this page), is my work safe, and the one next action.
  'self-update-too-old': `Releases before ${FIRST_SELF_UPDATE_RELEASE} can't update from this page, so this one update needs a command. It keeps your projects. After it, future updates are one click here.`,
  'self-update-unavailable': "Astrid can't update itself on this computer. Run the command below to update it.",
  'legacy-update-record': "This update was started by an older Astrid, so this one can't continue it. Next: run the update command from a terminal to start a fresh update.",
  'acknowledgement-unknown': "The update was started, but Astrid can't confirm yet that it was accepted. Next: wait a minute, then run the same update command again. It checks the earlier attempt before starting a new one.",
});

/** Shown under the command for self-update-too-old. */
export const SELF_UPDATE_TOO_OLD_STEPS = 'Open Terminal, paste the command, press Return. It takes a few minutes. When it says "Astrid updated", come back and select Check again.';
