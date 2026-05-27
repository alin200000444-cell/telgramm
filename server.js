const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const localtunnel = require('localtunnel'); 
const fs = require('fs'); 
const { exec } = require('child_process'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка хранилища для загружаемых аватарок
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
});

// Создание таблиц пользователей и сообщений + авто-создание админа
db.serialize(async () => {
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

    const adminUsername = 'VADMIN';
    const adminPasswordPlain = '123QWEEWQ321';
    const adminAvatar = 'https://flaticon.com'; 

    db.get(`SELECT * FROM users WHERE username = ?`, [adminUsername], async (err, row) => {
        if (!row && !err) {
            const hashedAdminPassword = await bcrypt.hash(adminPasswordPlain, 10);
            db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
                [adminUsername, hashedAdminPassword, adminAvatar], 
                (insertErr) => {
                    if (!insertErr) {
                        console.log(`\n👑 [БД] Аккаунт администратора успешно создан!`);
                        console.log(`👤 Логин: ${adminUsername}\n🔑 Пароль: ${adminPasswordPlain}\n`);
                    }
                }
            );
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
        db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
            [username.trim(), hashedPassword, avatarPath], 
            function(err) {
                if (err) return res.status(400).send('Пользователь уже существует');
                res.redirect('/login.html');
            }
        );
    } catch (e) { res.status(500).send('Ошибка сервера'); }
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
    } else { res.status(401).json({ error: 'Не авторизован' }); }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// --- API ДЛЯ СКАНИРОВАНИЯ ПАПКИ СО СМАЙЛИКАМИ ---
app.get('/get-custom-emojis', (req, res) => {
    const emojisDir = path.join(__dirname, 'public', 'emojis');
    if (!fs.existsSync(emojisDir)) fs.mkdirSync(emojisDir);

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
    io.emit('update users');

    socket.on('get users list', () => {
        db.all(`SELECT username, avatar FROM users WHERE username != ?`, [username], (err, rows) => {
            if (!err) socket.emit('users list', rows);
        });
    });

    socket.on('get chat history', (chatWith) => {
        db.all(`
            SELECT id, sender, receiver, text, timestamp FROM messages 
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
                const messageData = { id: this.lastID, sender: username, receiver: to, text };
                socket.emit('chat message', messageData);
                const targetSocketId = onlineUsers.get(to);
                if (targetSocketId) io.to(targetSocketId).emit('chat message', messageData);
            }
        });
    });

    socket.on('admin delete message', (msgId) => {
        if (username !== 'VADMIN') return;
        db.run(`DELETE FROM messages WHERE id = ?`, [msgId], (err) => {
            if (!err) io.emit('message deleted', msgId);
        });
    });

    // 👑 ИСПРАВЛЕННЫЙ БАН: Мгновенно выкидывает и очищает экран у админа
    socket.on('admin ban user', (targetUser) => {
        if (username !== 'VADMIN' || targetUser === 'VADMIN') return;
        const targetSocketId = onlineUsers.get(targetUser);

        db.run(`DELETE FROM users WHERE username = ?`, [targetUser], (err) => {
            if (!err) {
                db.run(`DELETE FROM messages WHERE sender = ? OR receiver = ?`, [targetUser, targetUser], () => {
                    if (targetSocketId) io.to(targetSocketId).emit('you are banned');
                    onlineUsers.delete(targetUser);
                    io.emit('user completely removed', targetUser);
                });
            }
        });
    });

    socket.on('disconnect', () => { onlineUsers.delete(username); });
});

// --- ЗАПУСК СЕРВЕРА И ТУННЕЛЯ ДЛЯ ДРУГИХ ГОРОДОВ БЕЗ ПАРОЛЕЙ ---
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`[СЕРВЕР] Локальный чат запущен на http://localhost:${PORT}`);
    console.log(`==================================================\n`);

    console.log(`⏳ Создаем прямую ссылку БЕЗ ПАРОЛЕЙ И ПРОВЕРОК для друзей...`);

    // Запускаем анонимный туннель localhost.run через веб-порт 443
    const tunnel = exec(`ssh -R 80:localhost:${PORT} -p 443 nokey@localhost.run`);

    tunnel.stdout.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[a-z0-9-]+\.(lhr\.life|localhost\.run)/);
        
        if (match) {
            console.log(`\n==================================================`);
            console.log(`🟢 ЧИСТАЯ ССЫЛКА ДЛЯ ДРУЗЕЙ ГОТОВА!`);
            console.log(`👉 Скопируйте и отправьте им: ${match[0]}`);
            console.log(`==================================================\n`);
        }
    });

    tunnel.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes("Are you sure you want to continue connecting")) {
            tunnel.stdin.write("yes\n");
        }
    });

    tunnel.on('close', (code) => {
        console.log(`[ТУННЕЛЬ] Соединение закрыто. Код: ${code}`);
    });
});
