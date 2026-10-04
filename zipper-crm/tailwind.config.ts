import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pink: { DEFAULT: '#E91E8C', 500: '#E91E8C', 600: '#C0186F' },
      },
    },
  },
  plugins: [],
}

export default config
