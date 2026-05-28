const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Настройка хранения файлов (Аватарки) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- Настройка Базы Данных SQLite ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Ошибка подключения к БД:', err.message);
    else console.log('Подключено к базе данных SQLite.');
});

// Создание таблиц при первом запуске
db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        role TEXT DEFAULT 'user'
    )`);

    // Таблица сообщений
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- Middleware (Промежуточное ПО) ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Раздача статики (HTML, CSS, JS)

// Настройка сессий (должна быть ПЕРЕД корневым роутом)
const sessionMiddleware = session({
    secret: 'super-secret-key-human-messenger',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Сессия на 1 день
});
app.use(sessionMiddleware);

// Делимся сессией Express с Socket.io
io.engine.use(sessionMiddleware);

// --- Корневой роут (Перенаправление на регистрацию) ---
app.get('/', (req, res) => {
    // Если пользователь авторизован — отдаем главный чат
    if (req.session && req.session.user) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        // Если не авторизован — самой первой открывается РЕГИСТРАЦИЯ
        res.sendFile(path.join(__dirname, 'public', 'register.html'));
    }
});

// --- Роуты авторизации (API) ---

// 1. Регистрация нового аккаунта
app.post('/register', upload.single('avatar'), (req, res) => {
    const { username, password } = req.body;
    const avatarPath = req.file ? `/uploads/${req.file.filename}` : '/user-avatar-default.png';

    if (!username || !password) {
        return res.status(400).json({ message: 'Заполните все поля' });
    }

    // Хэшируем пароль для безопасности
    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
        [username, hashedPassword, avatarPath], 
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ message: 'Это имя пользователя уже занято' });
                }
                return res.status(500).json({ message: 'Ошибка базы данных' });
            }
            res.status(200).json({ message: 'Регистрация успешна' });
        }
    );
});

// 2. Вход в аккаунт
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Заполните все поля' });
    }

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err) return res.status(500).json({ message: 'Ошибка сервера' });
        if (!user) return res.status(400).json({ message: 'Неверное имя пользователя или пароль' });

        // Проверяем пароль
        const isMatch = bcrypt.compareSync(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Неверное имя пользователя или пароль' });

        // Сохраняем данные в сессию
        req.session.user = { id: user.id, username: user.username, role: user.role };
        
        res.status(200).json({ message: 'Вход выполнен', username: user.username });
    });
});

// 3. Получение списка пользователей для сайдбара
app.get('/get-users', (req, res) => {
    db.all(`SELECT username, avatar, role FROM users`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Ошибка загрузки пользователей' });
        res.json(rows);
    });
});

// --- Работа с WebSockets (Socket.io) ---
io.on('connection', (socket) => {
    const req = socket.request;
    const sessionUser = req.session ? req.session.user : null;

    console.log(`Пользователь подключился к сокету: ${sessionUser ? sessionUser.username : 'Аноним'}`);

    // При подключении отправляем историю последних 50 сообщений
    db.all(`SELECT * FROM messages ORDER BY id DESC LIMIT 50`, [], (err, rows) => {
        if (!err) {
            socket.emit('chat-history', rows.reverse());
        }
    });

    // Обработка отправки нового сообщения
    socket.on('send-message', (msgText) => {
        if (!sessionUser) return;

        db.run(`INSERT INTO messages (username, text) VALUES (?, ?)`, [sessionUser.username, msgText], function(err) {
            if (!err) {
                io.emit('new-message', {
                    id: this.lastID,
                    username: sessionUser.username,
                    text: msgText,
                    timestamp: new Date()
                });
            }
        });
    });

    // Обработка удаления сообщения (для администратора)
    socket.on('delete-message', (msgId) => {
        if (!sessionUser || sessionUser.role !== 'admin') return;

        db.run(`DELETE FROM messages WHERE id = ?`, [msgId], (err) => {
            if (!err) {
                io.emit('message-deleted', msgId);
            }
        });
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился');
    });
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`Сервер мессенджера запущен по адресу: http://localhost:${PORT}`);
});
