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

// Настройка хранилища для загружаемых аватарок (используем временную папку ОС /tmp для совместимости с облаком)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Используем базу данных в оперативной памяти, чтобы хостинг не ругался на права записи файлов
const db = new sqlite3.Database(':memory:', (err) => {
    if (err) {
        console.error('Ошибка БД:', err.message);
    } else {
        console.log('ℹ️ [БД] База данных успешно запущена в оперативной памяти.');
    }
});

// Создание таблиц пользователей и сообщений + авто-создание админа
db.serialize(async () => {
    db.run(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, avatar TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    const adminUsername = 'VADMIN';
    const adminPasswordPlain = '123QWEEWQ321';
    const adminAvatar = 'https://flaticon.com';

    db.get(`SELECT * FROM users WHERE username = ?`, [adminUsername], async (err, row) => {
        if (!row && !err) {
            const hashedAdminPassword = await bcrypt.hash(adminPasswordPlain, 10);
            db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, [adminUsername, hashedAdminPassword, adminAvatar], (insertErr) => {
                if (!insertErr) {
                    console.log(`\n👑 [БД] Аккаунт администратора успешно создан!`);
                    console.log(`👤 Логин: ${adminUsername}\n🔑 Пароль: ${adminPasswordPlain}\n`);
                }
            });
        } else {
            console.log(`ℹ️ [БД] Аккаунт админа ${adminUsername} уже существует.`);
        }
    });
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

// --- API МАРШРУТЫ ---
app.post('/register', upload.single('avatar'), async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Заполните поля');
    const avatarPath = req.file ? `/uploads/${req.file.filename}` : 'https://flaticon.com';

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, [username.trim(), hashedPassword, avatarPath], function (err) {
            if (err) return res.status(400).send('Пользователь уже существует');
            res.redirect('/login.html');
        });
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

// --- API ДЛЯ СКАНИРОВАНИЯ ПАПКИ СО СМАЙЛИКАМИ ---
app.get('/get-custom-emojis', (req, res) => {
    const emojisDir = path.join(__dirname, 'public', 'emojis');
    if (!fs.existsSync(emojisDir)) {
        fs.mkdirSync(emojisDir, { recursive: true });
    }
    fs.readdir(emojisDir, (err, files) => {
        if (err) return res.status(500).json({ error: 'Не удалось прочитать папку' });
        const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
        const emojiFiles = files.filter(file => allowedExtensions.includes(path.extname(file).toLowerCase()));
        res.json(emojiFiles);
    });
});

const onlineUsers = new Map();

// --- СВЯЗЬ ЧЕРЕЗ СОКЕТЫ ---
io.on('connection', (socket) => {
    const username = socket.request.session.username;
    if (!username) return;
    onlineUsers.set(username, socket.id);
    io.emit('updateusers');

    socket.on('getuserslist', () => {
        db.all(`SELECT username, avatar FROM users WHERE username != ?`, [username], (err, rows) => {
            if (!err) socket.emit('userslist', rows);
        });
    });

    socket.on('getchathistory', (chatWith) => {
        db.all(`SELECT id, sender, receiver, text, timestamp FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC LIMIT 100`, [username, chatWith, chatWith, username], (err, rows) => {
            if (!err) socket.emit('loadhistory', rows);
        });
    });

    socket.on('privatemessage', ({ to, text }) => {
        if (!text.trim() || !to) return;
        db.run(`INSERT INTO messages (sender, receiver, text) VALUES (?, ?, ?)`, [username, to, text], function (err) {
            if (!err) {
                const messageData = { id: this.lastID, sender: username, receiver: to, text };
                socket.emit('chatmessage', messageData);
                const targetSocketId = onlineUsers.get(to);
                if (targetSocketId) io.to(targetSocketId).emit('chatmessage', messageData);
            }
        });
    });

    socket.on('admindeletemessage', (msgId) => {
        if (username !== 'VADMIN') return;
        db.run(`DELETE FROM messages WHERE id = ?`, [msgId], (err) => {
            if (!err) io.emit('messagedeleted', msgId);
        });
    });

    socket.on('adminbanuser', (targetUser) => {
        if (username !== 'VADMIN' || targetUser === 'VADMIN') return;
        const targetSocketId = onlineUsers.get(targetUser);
        db.run(`DELETE FROM users WHERE username = ?`, [targetUser], (err) => {
            if (!err) {
                db.run(`DELETE FROM messages WHERE sender = ? OR receiver = ?`, [targetUser, targetUser], () => {
                    if (targetSocketId) io.to(targetSocketId).emit('youarebanned');
                    onlineUsers.delete(targetUser);
                    io.emit('usercompletelyremoved', targetUser);
                });
            }
        });
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(username);
    });
});

// Автоматическое назначение порта от хостинга (process.env.PORT) или 3000 для локального запуска
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🟢 [СЕРВЕР] Успешно запущен глобально на порту: ${PORT}`);
    console.log(`==================================================\n`);
});
