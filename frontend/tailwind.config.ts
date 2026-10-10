import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // San Francisco (Mac system font), then Inter as the closest fallback off Apple devices.
        sans: ["-apple-system", "BlinkMacSystemFont", '"SF Pro Text"', '"Helvetica Neue"', "var(--font-sans)", "system-ui", "sans-serif"],
        display: ["-apple-system", "BlinkMacSystemFont", '"SF Pro Display"', '"Helvetica Neue"', "var(--font-sans)", "system-ui", "sans-serif"],
      },
    }
  },
  plugins: []
};

export default config;
