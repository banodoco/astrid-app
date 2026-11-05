import React from "react";
import { TimeOfDayControl } from "@/shared/components/TimeOfDay/TimeOfDayControl";
import { Button } from "@/shared/components/ui/button";
import { SettingsRow, SettingsSection } from "../SettingsLayout.tsx";
import type { PreferencesSectionProps } from "../types";

const PreferencesSection: React.FC<PreferencesSectionProps> = ({ onReplayTour }) => {
  return (
    <>
      <SettingsSection title="Appearance">
        <SettingsRow label="Brightness" description="How light or dark Astrid looks.">
          <TimeOfDayControl compact />
        </SettingsRow>
      </SettingsSection>

      {onReplayTour && (
        <SettingsSection title="Tour">
          <SettingsRow
            label="Astrid tour"
            description="Walk through what Astrid can do, step by step."
            action={<Button type="button" variant="retro-secondary" size="retro-sm" onClick={onReplayTour}>Replay tour</Button>}
          />
        </SettingsSection>
      )}
    </>
  );
};

export { PreferencesSection };
