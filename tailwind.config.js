/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    // Source files for processing
    "./src/ui/**/*.{js,jsx,ts,tsx,html}",
    "./src/**/*.{js,jsx,ts,tsx,html}",

    // Built files that get served
    "./dist/**/*.{js,jsx,ts,tsx,html}",

    // Root files
    "./*.{js,jsx,ts,tsx,html}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Tajawal', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}