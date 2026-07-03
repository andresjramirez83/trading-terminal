// src/components/ChartPanelV2/DrawingIcons.tsx

type IconProps = {
  size?: number;
};

function Svg({ size = 20, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {children}
    </svg>
  );
}

export function CursorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M6 3L18 13L12.5 14.2L10 20L6 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function TrendlineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M5 18L19 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="5" cy="18" r="2" fill="currentColor" />
      <circle cx="19" cy="6" r="2" fill="currentColor" />
    </Svg>
  );
}

export function HorizontalLineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4 12H20"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function RayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4 17L18 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M15.2 6.4L18 7L17.4 9.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4" cy="17" r="2" fill="currentColor" />
    </Svg>
  );
}

export function RectangleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect
        x="5"
        y="6"
        width="14"
        height="12"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="2"
      />
    </Svg>
  );
}

export function PriceRangeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4V20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 7L12 3L16 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 17L12 21L16 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 7H18M6 17H18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".8" />
    </Svg>
  );
}

export function DateRangeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 8L3 12L7 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 8L21 12L17 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function TextIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 6V19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 19H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function MagnetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M7 4V11C7 14.3 9.2 17 12 17C14.8 17 17 14.3 17 11V4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M7 8H11M13 8H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 4H11M13 4H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function EraserIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M5 15L13.5 6.5C14.3 5.7 15.7 5.7 16.5 6.5L18 8C18.8 8.8 18.8 10.2 18 11L11 18H6.8L5 16.2C4.7 15.9 4.7 15.3 5 15Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9 11L13 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 20H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".7" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M12 15.2A3.2 3.2 0 1 0 12 8.8A3.2 3.2 0 0 0 12 15.2Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M19 12C19 11.6 19 11.3 18.9 10.9L21 9.3L19 5.9L16.5 6.9C16 6.5 15.5 6.2 14.9 6L14.5 3.3H10.5L10.1 6C9.5 6.2 9 6.5 8.5 6.9L6 5.9L4 9.3L6.1 10.9C6 11.3 6 11.6 6 12C6 12.4 6 12.7 6.1 13.1L4 14.7L6 18.1L8.5 17.1C9 17.5 9.5 17.8 10.1 18L10.5 20.7H14.5L14.9 18C15.5 17.8 16 17.5 16.5 17.1L19 18.1L21 14.7L18.9 13.1C19 12.7 19 12.4 19 12Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 7V5H15V7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M7 7L8 20H16L17 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10.5 11V16M13.5 11V16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}
