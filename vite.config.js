import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        assetFileNames: asset => asset.names.includes('eng.traineddata.gz')
          ? 'assets/ocr-[hash]/[name][extname]'
          : 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
        },
      },
    },
  },
});
