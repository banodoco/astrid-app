/**
 * Generated from timeline.schema.json by scripts/emit-ts-types.mjs.
 * Do not edit by hand — regenerate with `npm run gen:types`.
 */
/**
 * A finite JSON descendant of an opaque metadata namespace.
 *
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "MetaValue".
 */
export type MetaValue = {
    [k: string]: MetaValue;
} | MetaValue[] | string | number | boolean | null;
/**
 * ASCII namespace key for opaque extension metadata.
 *
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "MetaNamespaceKey".
 */
export type MetaNamespaceKey = string;
export interface TimelineConfig {
    meta?: Meta;
    theme?: string;
    clips: TimelineClip[];
    tracks: {
        id: string;
        kind: "visual" | "audio";
        label: string;
        role?: "output" | "source";
        scale?: number;
        fit?: "cover" | "contain" | "manual";
        opacity?: number;
        volume?: number;
        muted?: boolean;
        blendMode?: "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "soft-light" | "hard-light";
        app?: {
            clipPlacementVersion?: 1;
            scaleAppliesToPositionedClips?: boolean;
            [k: string]: unknown;
        };
        meta?: Meta1;
    }[];
    pinnedShotGroups?: {
        shotId?: string;
        trackId?: string;
        clipIds?: string[];
        mode?: "images" | "video";
        videoAssetKey?: string;
        imageClipSnapshot?: {
            [k: string]: unknown;
        }[];
    }[];
    theme_overrides?: ThemeOverrides;
    generation_defaults?: {
        [k: string]: unknown;
    };
    app?: {
        [k: string]: unknown;
    };
    output?: TimelineOutput;
}
/**
 * Runtime-owned opaque extension metadata; ignored by TimelineConfig consumers.
 */
export interface Meta {
    [k: string]: MetaNamespaceValue;
}
/**
 * Opaque namespace payload; the namespace root is always an object.
 *
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "MetaNamespaceValue".
 */
export interface MetaNamespaceValue {
    [k: string]: MetaValue;
}
/**
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "TimelineClip".
 */
export interface TimelineClip {
    id: string;
    at: number;
    track: string;
    source_uuid?: string;
    clipType?: string;
    asset?: string;
    from?: number;
    to?: number;
    speed?: number;
    hold?: number;
    volume?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    cropTop?: number;
    cropBottom?: number;
    cropLeft?: number;
    cropRight?: number;
    opacity?: number;
    fit?: "contain" | "cover";
    text?: {
        content?: string;
        fontFamily?: string;
        fontSize?: number;
        color?: string;
        align?: "left" | "center" | "right";
        bold?: boolean;
        italic?: boolean;
    };
    entrance?: {
        id?: string;
        type?: string;
        duration?: number;
        durationFrames?: number;
        easing?: string;
        intensity?: number;
        params?: {
            [k: string]: unknown;
        };
    };
    exit?: {
        id?: string;
        type?: string;
        duration?: number;
        durationFrames?: number;
        easing?: string;
        intensity?: number;
        params?: {
            [k: string]: unknown;
        };
    };
    continuous?: {
        type?: string;
        intensity?: number;
        params?: {
            [k: string]: unknown;
        };
    };
    transition?: {
        type: string;
        duration: number;
    } | {
        id?: string;
        type?: string;
        duration?: number;
        durationFrames?: number;
        params?: {
            [k: string]: unknown;
        };
    } | string;
    effects?: {
        fade_in?: number;
        fade_out?: number;
    }[] | {
        [k: string]: number;
    };
    params?: {
        [k: string]: unknown;
    };
    generation?: {
        [k: string]: unknown;
    };
    app?: {
        [k: string]: unknown;
    };
    label?: string;
    pool_id?: string;
    clip_order?: number;
    keyframes?: {
        [k: string]: unknown;
    };
    derived_output?: {
        [k: string]: unknown;
    };
    meta?: Meta1;
}
/**
 * Optional bounded namespace map. Canonical byte and depth limits are provider-enforced.
 *
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "Meta".
 */
export interface Meta1 {
    [k: string]: MetaNamespaceValue;
}
/**
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "ThemeOverrides".
 */
export interface ThemeOverrides {
    visual?: {
        [k: string]: unknown;
    };
    generation?: {
        [k: string]: unknown;
    };
    voice?: {
        [k: string]: unknown;
    };
    audio?: {
        [k: string]: unknown;
    };
    pacing?: {
        [k: string]: unknown;
    };
}
/**
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "TimelineOutput".
 */
export interface TimelineOutput {
    resolution: string;
    fps: number;
    file: string;
    background?: string | null;
    background_scale?: number | null;
}
/**
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "Theme".
 */
export interface Theme {
    id: string;
    visual?: {
        [k: string]: unknown;
    };
    generation?: {
        [k: string]: unknown;
    };
    voice?: {
        [k: string]: unknown;
    };
    audio?: {
        [k: string]: unknown;
    };
    pacing?: {
        [k: string]: unknown;
    };
    [k: string]: unknown;
}
/**
 * This interface was referenced by `TimelineConfig`'s JSON-Schema
 * via the `definition` "AssetEntry".
 */
export interface AssetEntry {
    file?: string;
    url?: string;
    etag?: string;
    content_sha256?: string;
    url_expires_at?: string;
    type?: string;
    duration?: number;
    resolution?: string;
    fps?: number;
    generationId?: string;
    variantId?: string;
    thumbnailUrl?: string;
    meta?: Meta1;
}
export type TimelineClipT = TimelineClip;
export type TimelineConfigT = TimelineConfig;
export type ThemeT = Theme;
export type ThemeOverridesT = ThemeOverrides;
export type TimelineOutputT = TimelineOutput;
export type AssetEntryT = AssetEntry;
//# sourceMappingURL=generated.d.ts.map