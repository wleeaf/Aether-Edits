/**
 * Small inline-SVG icon library. Lucide-style stroke icons, 16×16 viewBox,
 * `currentColor` stroke so they pick up the parent's color. Size is set via
 * the CSS `.icon-sm` / `.icon-md` / `.icon-lg` classes (14/16/20 px) or
 * directly via the `size` prop.
 *
 * Replaces the previous emoji-as-icons everywhere — emoji are inconsistent
 * across platforms, have unpredictable baselines, and don't theme via CSS
 * color. This module is the single place icon glyphs live.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
});

// ─── Transport ────────────────────────────────────────────────────────────

export const PlayIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    {/* Right-pointing filled triangle, visually centered (not glyph-centered). */}
    <path d="M4.5 3.2 12.2 8 4.5 12.8z" fill="currentColor" stroke="none" />
  </svg>
);

export const PauseIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="4" y="3" width="2.8" height="10" rx="0.5" fill="currentColor" stroke="none" />
    <rect x="9.2" y="3" width="2.8" height="10" rx="0.5" fill="currentColor" stroke="none" />
  </svg>
);

export const SkipStartIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="3" y="3.2" width="1.6" height="9.6" rx="0.4" fill="currentColor" stroke="none" />
    <path d="M13 3.2 5.6 8 13 12.8z" fill="currentColor" stroke="none" />
  </svg>
);

export const SkipEndIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 3.2 10.4 8 3 12.8z" fill="currentColor" stroke="none" />
    <rect x="11.4" y="3.2" width="1.6" height="9.6" rx="0.4" fill="currentColor" stroke="none" />
  </svg>
);

// ─── Actions ──────────────────────────────────────────────────────────────

export const SplitIcon = ({ size, ...rest }: IconProps) => (
  // Scissors — open at top, closed at bottom.
  <svg {...base(size)} {...rest}>
    <circle cx="4.2" cy="11.2" r="1.7" />
    <circle cx="11.8" cy="11.2" r="1.7" />
    <path d="M5.4 9.9 13 2.4" />
    <path d="M10.6 9.9 3 2.4" />
  </svg>
);

export const TransitionIcon = ({ size, ...rest }: IconProps) => (
  // Two overlapping rectangles fading into each other.
  <svg {...base(size)} {...rest}>
    <rect x="2" y="4" width="6.5" height="8" rx="1" />
    <rect x="7.5" y="4" width="6.5" height="8" rx="1" opacity="0.45" />
  </svg>
);

export const DeleteIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 4.2h10" />
    <path d="M5.6 4.2V3a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.2" />
    <path d="M4.5 4.2 5 12.4a1.2 1.2 0 0 0 1.2 1.1h3.6a1.2 1.2 0 0 0 1.2-1.1l.5-8.2" />
  </svg>
);

export const SpeedIcon = ({ size, ...rest }: IconProps) => (
  // Gauge with a needle.
  <svg {...base(size)} {...rest}>
    <path d="M2.5 11.5a5.5 5.5 0 0 1 11 0" />
    <path d="m8 11 3-3.5" />
    <circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

export const LayersFrontIcon = ({ size, ...rest }: IconProps) => (
  // Stacked layers with the topmost highlighted by an outline.
  <svg {...base(size)} {...rest}>
    <rect x="2" y="6" width="9" height="6" rx="1" opacity="0.45" />
    <rect x="5" y="3" width="9" height="6" rx="1" />
  </svg>
);

export const LayersBackIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="5" y="3" width="9" height="6" rx="1" opacity="0.45" />
    <rect x="2" y="6" width="9" height="6" rx="1" />
  </svg>
);

export const LayerUpIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="3" y="9" width="10" height="4" rx="0.8" opacity="0.45" />
    <rect x="3" y="3.5" width="10" height="4" rx="0.8" />
    <path d="M8 6V2.5" />
    <path d="M6.5 4 8 2.5 9.5 4" />
  </svg>
);

export const LayerDownIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="3" y="3" width="10" height="4" rx="0.8" opacity="0.45" />
    <rect x="3" y="8.5" width="10" height="4" rx="0.8" />
    <path d="M8 10v3.5" />
    <path d="M6.5 12 8 13.5 9.5 12" />
  </svg>
);

// ─── Nav / util ───────────────────────────────────────────────────────────

export const SearchIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m13.5 13.5-3-3" />
  </svg>
);

export const UndoIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 7h7a3.5 3.5 0 0 1 0 7H7.5" />
    <path d="M5.5 4.5 3 7l2.5 2.5" />
  </svg>
);

export const RedoIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M13 7H6a3.5 3.5 0 0 0 0 7h2.5" />
    <path d="M10.5 4.5 13 7l-2.5 2.5" />
  </svg>
);

export const ClapperIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="2" y="6" width="12" height="7.5" rx="1" />
    <path d="m2.5 6 1.2-2.2 2.4 1L4.8 7" />
    <path d="m6.7 4.8 1.2-2.2 2.4 1L9 5.8" />
    <path d="m10.9 3.6 1.2-2.2 2.4 1-1.3 2.2" />
  </svg>
);

export const ChevronDownIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="m4 6 4 4 4-4" />
  </svg>
);

export const XIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="m4 4 8 8" />
    <path d="m12 4-8 8" />
  </svg>
);

export const PlusIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M8 3v10" />
    <path d="M3 8h10" />
  </svg>
);

export const ImageIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <circle cx="5.5" cy="6.5" r="1" />
    <path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5" />
  </svg>
);

export const VideoIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="2" y="4" width="9" height="8" rx="1" />
    <path d="m11 7 3-1.6v5.2L11 9z" />
  </svg>
);

export const TextIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 4h10" />
    <path d="M8 4v9" />
    <path d="M5.5 13h5" />
  </svg>
);

export const SparkleIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2" />
  </svg>
);

export const SettingsIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="8" cy="8" r="2" />
    <path d="M13 8a5 5 0 0 0-.1-1l1.4-1-1.4-2.5-1.6.6a5 5 0 0 0-1.7-1L9.3 1.5h-2.6L6.4 3a5 5 0 0 0-1.7 1l-1.6-.6L1.7 6l1.4 1A5 5 0 0 0 3 8a5 5 0 0 0 .1 1l-1.4 1 1.4 2.5 1.6-.6a5 5 0 0 0 1.7 1l.3 1.6h2.6l.3-1.6a5 5 0 0 0 1.7-1l1.6.6 1.4-2.5-1.4-1A5 5 0 0 0 13 8z" />
  </svg>
);

export const DownloadIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M8 2v8" />
    <path d="m5 7 3 3 3-3" />
    <path d="M3 12.5v1A0.5.5 0 0 0 3.5 14h9a0.5.5 0 0 0 0.5-0.5v-1" />
  </svg>
);

export const SaveIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 3.5A0.5.5 0 0 1 3.5 3h7l2.5 2.5v7A0.5.5 0 0 1 12.5 13h-9A0.5.5 0 0 1 3 12.5v-9z" />
    <rect x="5.5" y="3" width="5" height="3" />
    <rect x="5" y="8.5" width="6" height="4.5" />
  </svg>
);

export const UploadIcon = ({ size, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M8 10V2" />
    <path d="m5 5 3-3 3 3" />
    <path d="M3 12.5v1A0.5.5 0 0 0 3.5 14h9a0.5.5 0 0 0 0.5-0.5v-1" />
  </svg>
);
