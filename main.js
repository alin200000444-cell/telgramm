const { app, BrowserWindow, dialog, clipboard } = require('electron');
const path = require('path');
const localtunnel = require('localtunnel'); // Подключаем встроенный туннель

// Запускаем наш сервер в фоне
require('./server.js'); 

function createWindow () {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    autoHideMenuBar: true, 
    icon: path.join(__dirname, 'public/favicon.ico'),
    webPreferences: {
      nodeIntegration: false
    }
  });

  // Загружаем наш мессенджер
  win.loadURL('http://localhost:3000');

  // Включаем автоматический туннель для друга из другого города
  win.webContents.on('did-finish-load', async () => {
    try {
      // Открываем порт 3000 для всего интернета
      const tunnel = await localtunnel({ port: 3000 });

      // tunnel.url — это готовая секретная ссылка (например, https://localtha.net)
      console.log('Ссылка для друга:', tunnel.url);

      // Автоматически копируем эту ссылку в ваш буфер обмена, чтобы не искать её
      clipboard.writeText(tunnel.url);

      // Показываем красивое всплывающее окошко прямо в программе
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Мессенджер готов!',
        message: `Ссылка для друга из другого города создана и автоматически скопирована в буфер обмена!\n\nПросто отправь её ему в Telegram/VK.\n\nСсылка: ${tunnel.url}`,
        buttons: ['Отлично, скопировано']
      });

      tunnel.on('close', () => {
        console.log('Туннель закрыт');
      });

    } catch (err) {
      console.error('Ошибка создания туннеля:', err);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
