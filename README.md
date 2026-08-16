# SnapGen AI Studio

Desktop app (Electron) tạo video AI multi-scene:

1. **ChatGPT** viết kịch bản nhiều cảnh  
2. **Snapgen** gen từng clip (Veo / Sora / Grok / Seedance / Kling / Meta)  
3. **ElevenLabs** tạo voice + subtitle  
4. **FFmpeg** ghép thành video cuối  

API keys cấu hình trong **Settings** trên UI (không cần `.env`).

## Chạy

```bash
npm install
npm start
```

## Hot reload (dev)

`npm run dev` (hoặc `npm start`) chạy chế độ dev với hot reload đầy đủ:

| Sửa file trong | Kết quả |
| --- | --- |
| `src/renderer/**` | HMR / React Fast Refresh, không mất state |
| `src/preload/**` | Rebuild + reload cửa sổ |
| `src/main/**`, `src/shared/**` | Rebuild + **tự restart Electron** |

Auto restart do plugin `snapgen:hot-restart-main` trong `vite.main.config.ts` lo: sau mỗi lần
rebuild main nó phát chuỗi `rs` vào stdin — đúng tín hiệu restart của Electron Forge. Cần chạy
trong terminal thật (TTY); nếu stdin không phải TTY thì log sẽ nhắc gõ `rs` thủ công.

Lưu ý: restart sẽ giết tiến trình main, nên job đang chạy (FFmpeg, gọi API…) bị hủy theo.

Docs API Snapgen nằm ở `content/` và `openapi.json`.
