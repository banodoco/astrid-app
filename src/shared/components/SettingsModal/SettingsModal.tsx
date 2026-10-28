import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/shared/components/ui/dialog";
import { Button } from "@/shared/components/ui/button";
import { useIsMobile } from "@/shared/hooks/mobile";
import { useLargeModal } from '@/shared/hooks/useModal';
import { useScrollFade } from "@/shared/hooks/useScrollFade";
import { PreferencesSection } from "./sections/PreferencesSection";
import { AstridStatusSection } from "./sections/AstridStatusSection";
import { AstridUpdatesSection } from "./sections/AstridUpdatesSection";
import type { SettingsModalProps } from "./types";

const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onOpenChange,
  onReplayTour,
}) => {
  const isMobile = useIsMobile();

  // Modal styling and scroll fade
  const modal = useLargeModal();
  const { showFade, scrollRef } = useScrollFade({
    isOpen: isOpen,
    debug: false,
    preloadFade: modal.isMobile
  });

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className={modal.className}
        style={(() => {
          const desktopMaxHeight = 'calc(100vh - 24px)';
          const maxHeight = modal.isMobile
            ? (modal.style.maxHeight as string | undefined) ?? '90vh'
            : desktopMaxHeight;
          return {
            ...modal.style,
            maxHeight,
          };
        })()}
      >

        <div className={modal.headerClass}>
          <DialogHeader className={`${modal.isMobile ? 'px-2 pt-1 pb-1' : 'px-2 pt-1 pb-1'} flex-shrink-0 relative`}>
            <div className={`flex ${isMobile ? 'flex-col items-center gap-3' : 'items-center gap-4'}`}>
              <DialogTitle className={`text-2xl ${isMobile ? 'mb-1' : 'md:mt-[11px]'}`}>
                App Settings
              </DialogTitle>
            </div>
          </DialogHeader>
        </div>

        {/* Scrollable content container */}
        <div
          ref={scrollRef}
          className={`${modal.scrollClass} ${modal.isMobile ? 'px-2' : 'px-2'} overflow-x-hidden [scrollbar-gutter:stable_both-edges] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] sm:[&::-webkit-scrollbar]:block sm:[-ms-overflow-style:auto] sm:[scrollbar-width:auto] sm:pr-4`}
        >
          <AstridUpdatesSection isOpen={isOpen} />
          <AstridStatusSection isOpen={isOpen} />
          <PreferencesSection
            isMobile={isMobile}
            onReplayTour={onReplayTour && (() => {
              onOpenChange(false);
              onReplayTour();
            })}
          />

        </div>

        {/* Footer */}
        <div className={`${modal.footerClass} relative`}>
          {/* Fade overlay */}
          {showFade && (
            <div
              className="absolute top-0 left-0 right-0 h-16 pointer-events-none z-10"
              style={{ transform: 'translateY(-64px)' }}
            >
              <div className="h-full bg-gradient-to-t from-background via-background/95 to-transparent" />
            </div>
          )}

          <DialogFooter className={`${modal.isMobile ? 'px-2 pt-6 pb-3 flex-row justify-between' : 'px-2 pt-7 pb-3'} border-t relative z-20`}>
            <Button variant="retro" size="retro-sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export { SettingsModal };
