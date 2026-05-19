const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка хранилища для загружаемых аватарок
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        // Сохраняем файл под уникальным именем: timestamp + оригинальное расширение
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
});

// Обновляем таблицу пользователей — добавляем поле avatar
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        receiver TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

const sessionMiddleware = session({
    secret: 'super-secret-key-123',
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// --- API РЕГИСТРАЦИИ С ЗАГРУЗКОЙ ФОТО ---
app.post('/register', upload.single('avatar'), async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Заполните поля');

    // Если файл не загружен, ставим стандартную аватарку-заглушку
    const avatarPath = req.file ? `/uploads/${req.file.filename}` : 'https://flaticon.com';

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
            [username.trim(), hashedPassword, avatarPath], 
            function(err) {
                if (err) return res.status(400).send('Пользователь уже существует');
                res.redirect('/login.html');
            }
        );
    } catch (e) {
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username.trim()], async (err, user) => {
        if (err || !user) return res.status(400).send('Пользователь не найден');
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).send('Неверный пароль');
        req.session.username = user.username;
        res.redirect('/');
    });
});

app.get('/get-user', (req, res) => {
    if (req.session.username) {
        // Отдаем фронтенду не только имя, но и аватарку текущего пользователя
        db.get(`SELECT username, avatar FROM users WHERE username = ?`, [req.session.username], (err, user) => {
            if (user) res.json(user);
            else res.status(401).json({ error: 'Не найден' });
        });
    } else {
        res.status(401).json({ error: 'Не авторизован' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

const onlineUsers = new Map();

// --- СВЯЗЬ ЧЕРЕЗ СОКЕТЫ ---
io.on('connection', (socket) => {
    const username = socket.request.session.username;
    if (!username) return;

    onlineUsers.set(username, socket.id);
    io.emit('update users');

    // Отправляем список пользователей вместе с их аватарками
    socket.on('get users list', () => {
        db.all(`SELECT username, avatar FROM users WHERE username != ?`, [username], (err, rows) => {
            if (!err) socket.emit('users list', rows);
        });
    });

    socket.on('get chat history', (chatWith) => {
        db.all(`
            SELECT sender, receiver, text FROM messages 
            WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
            ORDER BY id ASC LIMIT 100
        `, [username, chatWith, chatWith, username], (err, rows) => {
            if (!err) socket.emit('load history', rows);
        });
    });

    socket.on('private message', ({ to, text }) => {
        if (!text.trim() || !to) return;
        db.run(`INSERT INTO messages (sender, receiver, text) VALUES (?, ?, ?)`, [username, to, text], function(err) {
            if (!err) {
                const messageData = { sender: username, receiver: to, text };
                socket.emit('chat message', messageData);
                const targetSocketId = onlineUsers.get(to);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('chat message', messageData);
                }
            }
        });
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(username);
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}`));
