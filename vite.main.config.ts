import { defineConfig, type ConfigEnv, type Plugin } from 'vite';
import path from 'node:path';

/**
 * Forge rebuild main mỗi khi file đổi nhưng KHÔNG khởi động lại Electron —
 * hook 'restart' trong @electron-forge/plugin-vite đang để trống (electron/forge#3380).
 * Cách Forge restart app là đọc chuỗi `rs` từ stdin, nên sau mỗi lần rebuild
 * ta phát lại đúng tín hiệu đó để có hot restart thật sự.
 */
function hotRestartMain(): Plugin {
  let builtOnce = false;
  let timer: NodeJS.Timeout | null = null;

  return {
    name: 'snapgen:hot-restart-main',
    closeBundle() {
      // Lần build đầu chạy trước khi Electron khởi động → chưa có gì để restart.
      if (!builtOnce) {
        builtOnce = true;
        return;
      }
      if (timer) clearTimeout(timer);
      // Gộp các lần lưu liên tiếp thành một lần restart.
      timer = setTimeout(() => {
        if (!process.stdin.isTTY) {
          console.log('\n[hot-restart] Main đã rebuild. stdin không phải TTY → gõ `rs` để restart thủ công.');
          return;
        }
        console.log('\n[hot-restart] Main đổi → restart Electron…');
        process.stdin.emit('data', 'rs');
      }, 120);
      timer.unref();
    },
  };
}

export default defineConfig((env: ConfigEnv) => ({
  // `serve` = electron-forge start (dev), `build` = package/make.
  plugins: env.command === 'serve' ? [hotRestartMain()] : [],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    rollupOptions: {
      external: [
        // Pure JS → bundle vào main.js (tránh thiếu node_modules khi package)
        // Binary / native → external + giữ trong forge.config ignore whitelist
        'ffmpeg-static',
        'ffprobe-static',
        'electron',
        'sharp',
        '@pilio/gemini-watermark-remover',
        '@pilio/gemini-watermark-remover/node',
      ],
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
}));
