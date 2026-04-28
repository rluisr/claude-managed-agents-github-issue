export const tokens = {
  colors: {
    brand: {
      50: "#f0fdfa",
      100: "#ccfbf1",
      200: "#99f6e4",
      300: "#5eead4",
      400: "#2dd4bf",
      500: "#14b8a6",
      600: "#0d9488",
      700: "#0f766e",
      800: "#115e59",
      900: "#134e4a",
      950: "#042f2e",
    },
    neutral: {
      50: "#f8fafc",
      100: "#f1f5f9",
      200: "#e2e8f0",
      300: "#cbd5e1",
      400: "#94a3b8",
      500: "#64748b",
      600: "#475569",
      700: "#334155",
      800: "#1e293b",
      900: "#0f172a",
      950: "#020617",
    },
    info: {
      50: "#eff6ff",
      100: "#dbeafe",
      200: "#bfdbfe",
      300: "#93c5fd",
      400: "#60a5fa",
      500: "#3b82f6",
      600: "#2563eb",
      700: "#1d4ed8",
      800: "#1e40af",
      900: "#1e3a8a",
      950: "#172554",
    },
    success: {
      50: "#f0fdf4",
      100: "#dcfce7",
      200: "#bbf7d0",
      300: "#86efac",
      400: "#4ade80",
      500: "#22c55e",
      600: "#16a34a",
      700: "#15803d",
      800: "#166534",
      900: "#14532d",
      950: "#052e16",
    },
    warning: {
      50: "#fffbeb",
      100: "#fef3c7",
      200: "#fde68a",
      300: "#fcd34d",
      400: "#fbbf24",
      500: "#f59e0b",
      600: "#d97706",
      700: "#b45309",
      800: "#92400e",
      900: "#78350f",
      950: "#451a03",
    },
    danger: {
      50: "#fef2f2",
      100: "#fee2e2",
      200: "#fecaca",
      300: "#fca5a5",
      400: "#f87171",
      500: "#ef4444",
      600: "#dc2626",
      700: "#b91c1c",
      800: "#991b1b",
      900: "#7f1d1d",
      950: "#450a0a",
    },
    surface: {
      DEFAULT: "#ffffff",
      muted: "#f8fafc",
      inverse: "#0f172a",
    },
    status: {
      queued: {
        bg: "#f1f5f9", // neutral-100
        fg: "#334155", // neutral-700
        border: "#cbd5e1", // neutral-300
      },
      running: {
        bg: "#eff6ff", // info-50
        fg: "#1d4ed8", // info-700
        border: "#bfdbfe", // info-200
      },
      completed: {
        bg: "#f0fdf4", // success-50
        fg: "#15803d", // success-700
        border: "#bbf7d0", // success-200
      },
      failed: {
        bg: "#fef2f2", // danger-50
        fg: "#b91c1c", // danger-700
        border: "#fecaca", // danger-200
      },
      aborted: {
        bg: "#fffbeb", // warning-50
        fg: "#b45309", // warning-700
        border: "#fde68a", // warning-200
      },
    },
  },
  spacing: {
    "1": "0.25rem", // 4px
    "2": "0.5rem", // 8px
    "4": "1rem", // 16px
    "6": "1.5rem", // 24px
    "8": "2rem", // 32px
    "12": "3rem", // 48px
    "16": "4rem", // 64px
  },
  radius: {
    sm: "0.125rem", // 2px
    md: "0.375rem", // 6px
    lg: "0.5rem", // 8px
    full: "9999px",
  },
  font: {
    sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
    mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
  },
  shadow: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  },
} as const;
