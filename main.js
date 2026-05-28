const { app, BrowserWindow, dialog, clipboard } = require('electron');
const path = require('path');
const localtunnel = require('localtunnel'); 

// Переменная для хранения ссылки туннеля, чтобы показать её при создании окна
let globalTunnelUrl = null;

// Запускаем наш бэкенд-сервер в фоне
require('./server.js'); 

function createWindow () {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    autoHideMenuBar: true, 
    icon: path.join(__dirname, 'public/favicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true // Включаем для безопасности, раз подключаемся из интернета
    }
  });

  // Загружаем наш мессенджер
  win.loadURL('http://localhost:3000');

  // Если туннель к этому моменту уже успешно запустился, показываем уведомление
  if (globalTunnelUrl) {
    showTunnelDialog(win, globalTunnelUrl);
  } else {
    // Если туннель еще создается, подождем и покажем окно чуть позже
    app.once('tunnel-ready', (url) => {
      if (!win.isDestroyed()) {
        showTunnelDialog(win, url);
      }
    });
  }
}

// Вынесли создание диалогового окна в отдельную функцию, чтобы не дублировать код
function showTunnelDialog(window, url) {
  clipboard.writeText(url);
  dialog.showMessageBox(window, {
    type: 'info',
    title: 'Мессенджер готов!',
    message: `Ссылка для друга из другого города создана и автоматически скопирована в буфер обмена!\n\nПросто отправь её ему в Telegram/VK.\n\nСсылка: ${url}`,
    buttons: ['Отлично, скопировано']
  });
}

// Функция инициализации локального туннеля
async function startTunnel() {
  try {
    // Даем серверу server.js 500мс на гарантированный запуск и подъем порта
    await new Promise(resolve => setTimeout(resolve, 500));

    // Открываем порт 3000 для всего интернета (создается ОДИН раз при запуске приложения)
    const tunnel = await localtunnel({ port: 3000 });
    globalTunnelUrl = tunnel.url;
    console.log('Ссылка для друга:', globalTunnelUrl);

    // Оповещаем приложение, что туннель готов
    app.emit('tunnel-ready', globalTunnelUrl);

    tunnel.on('close', () => {
      console.log('Туннель закрыт');
    });

  } catch (err) {
    console.error('Ошибка создания туннеля:', err);
  }
}

app.whenReady().then(async () => {
  // Сначала запускаем туннель в фоне
  await startTunnel();
  
  // Затем создаем графическое окно
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
