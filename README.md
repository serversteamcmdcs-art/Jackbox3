# 🎮 Jackbox All-in-One Private Server

Приватный сервер для **ВСЕХ** версий Jackbox Games.
Один сервер — два протокола (Ecast + Blobcast), готов к деплою на Render.com.

## ✅ Поддерживаемые игры

| Пак | Протокол | Статус |
|-----|----------|--------|
| Party Pack 1 (Fibbage, Drawful, Lie Swatter...) | Blobcast | ✅ |
| Party Pack 2 (Fibbage 2, Quiplash XL, Earwax...) | Blobcast | ✅ |
| Party Pack 3 (Quiplash 2, Trivia Murder Party...) | Blobcast | ✅ |
| Party Pack 4 (Fibbage 3, Survive the Internet...) | Blobcast | ✅ |
| Party Pack 5 (Split the Room, Mad Verse City...) | Blobcast | ✅ |
| Party Pack 6 (TMP2, Joke Boat, Role Models...) | Blobcast | ✅ |
| Party Pack 7 (Quiplash 3, Champ'd Up...) | Ecast | ✅ |
| Party Pack 8 (Job Job, Drawful Animate...) | Ecast | ✅ |
| Drawful 2 International | Ecast | ✅ |
| Quiplash 2 InterLASHional | Blobcast | ✅ |

## 🚀 Деплой на Render

1. Загрузи все файлы на GitHub
2. render.com → New → Web Service → подключи репо
3. Build: `npm install`, Start: `node server.js`
4. В игре укажи: `-jbg.config serverUrl=https://ТВОЙдомен.onrender.com`

## Проверка: GET /health
