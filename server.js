const express = require('express');
const session = require('cookie-session');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const USERS_FILE = path.join(__dirname, 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (password, storedPassword) => {
  const [salt, originalHash] = storedPassword.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
};

const readData = (filePath) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([]));
    return [];
  }
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return data ? JSON.parse(data) : [];
  } catch (err) {
    return [];
  }
};

const writeData = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

const broadcast = (data) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
  name: 'messenger_session',
  keys: ['super-secret-key-human-messenger'],
  maxAge: 24 * 60 * 60 * 1000,
  secure: false,
  sameSite: 'lax'
}));


app.get('/api/check-auth', (req, res) => {
  if (req.session && req.session.user) {
    return res.status(200).json({ authorized: true, user: req.session.user });
  }
  res.status(200).json({ authorized: false });
});

app.post('/api/register', async (req, res) => {
  const { username, password, avatarBase64 } = req.body;
  const avatarPath = avatarBase64 || '/user-avatar-default.png';

  if (!username || !password) {
    return res.status(400).json({ message: 'Заполните все поля' });
  }

  const users = readData(USERS_FILE);
  const userExists = users.some(u => u.username.toLowerCase() === username.toLowerCase());

  if (userExists) {
    return res.status(400).json({ message: 'Это имя пользователя уже занято' });
  }

  try {
    const hashedPassword = hashPassword(password);
    const newUser = {
      id: users.length + 1,
      username,
      password: hashedPassword,
      avatar: avatarPath,
      role: users.length === 0 ? 'admin' : 'user'
    };

    users.push(newUser);
    writeData(USERS_FILE, users);
    res.status(200).json({ message: 'Регистрация успешна' });
  } catch (err) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Заполните все поля' });
  }

  const users = readData(USERS_FILE);
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user || !verifyPassword(password, user.password)) {
    return res.status(400).json({ message: 'Неверное имя пользователя или пароль' });
  }

  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.status(200).json({ message: 'Вход выполнен', username: user.username });
});



app.get('/api/get-users', async (req, res) => {
  const users = readData(USERS_FILE);
  const publicUsers = users.map(({ username, avatar, role }) => ({ username, avatar, role }));
  res.json(publicUsers);
});

app.get('/api/messages', async (req, res) => {
  const messages = readData(MESSAGES_FILE);
  res.json(messages.slice(-50));
});

app.post('/api/send-message', async (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ message: 'Не авторизован' });
  const { text } = req.body;

  const messages = readData(MESSAGES_FILE);
  const newMessage = {
    id: messages.length + 1,
    username: req.session.user.username,
    text: text,
    timestamp: new Date().toISOString()
  };

  messages.push(newMessage);
  writeData(MESSAGES_FILE, messages);

  broadcast({ type: 'new-message', data: newMessage });
  res.status(200).json(newMessage);
});

app.post('/api/delete-message', async (req, res) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: 'Нет прав' });
  }
  const { msgId } = req.body;

  let messages = readData(MESSAGES_FILE);
  const initialLength = messages.length;
  messages = messages.filter(m => m.id !== parseInt(msgId));

  if (messages.length === initialLength) {
    return res.status(404).json({ message: 'Сообщение не найдено' });
  }

  writeData(MESSAGES_FILE, messages);

  broadcast({ type: 'message-deleted', id: msgId });
  res.status(200).json({ success: true });
});

app.get('/api/emojis', (req, res) => {
  const emojisDir = path.join(__dirname, 'public', 'emojis');
  if (!fs.existsSync(emojisDir)) {
    fs.mkdirSync(emojisDir, { recursive: true });
    return res.json([]);
  }
  try {
    const files = fs.readdirSync(emojisDir);
    const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const emojiFiles = files.filter(file => allowedExtensions.includes(path.extname(file).toLowerCase()));
    res.json(emojiFiles);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка чтения папки emojis' });
  }
});

app.post('/api/upload-video', (req, res) => {
  const { videoBase64 } = req.body;
  if (!videoBase64) return res.status(400).json({ message: 'Нет данных видео' });

  const publicDir = path.join(__dirname, 'public');
  const videosDir = path.join(publicDir, 'videos');
  
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

  try {
    const base64Data = videoBase64.split(';base64,').pop();
    const fileName = `video_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.webm`;
    const filePath = path.join(videosDir, fileName);

    fs.writeFileSync(filePath, base64Data, 'base64');
    res.status(200).json({ videoUrl: `/videos/${fileName}` });
  } catch (err) {
    res.status(500).json({ message: 'Ошибка сохранения видео' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
