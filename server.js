const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || "mujabeed-secret";

async function ensureUserStatsColumns() {
    try {
        await pool.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS losses INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS points INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS games_played INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS weekly_points INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS monthly_points INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS last_game_at TIMESTAMP
        `);

        console.log("✅ جدول المستخدمين جاهز للإحصائيات");
    } catch (err) {
        console.error("❌ خطأ تجهيز أعمدة الإحصائيات:", err.message);
    }
}

ensureUserStatsColumns();


async function verifyActiveSession(token) {
    if (!token) return null;

    const data = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
        "SELECT id, username FROM users WHERE id = $1",
        [data.id]
    );

    const user = result.rows[0];
    if (!user) return null;

    const sessionResult = await pool.query(
        "SELECT id FROM sessions WHERE user_id = $1 AND session_token = $2",
        [data.id, data.sessionToken]
    );

    if (sessionResult.rows.length === 0) return null;

    return {
        id: user.id,
        username: user.username,
        sessionToken: data.sessionToken
    };
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/style.css", (req, res) => {
    res.type("text/css");
    res.sendFile(path.join(__dirname, "public", "style.css"));
});

app.get("/app.js", (req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(__dirname, "public", "app.js"));
});

app.get("/socket.io/socket.io.js", (req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(__dirname, "node_modules", "socket.io", "client-dist", "socket.io.js"));
});

let waitingPlayers = [];
const rooms = new Map();
const publicRooms = new Map(); // roomId -> { title, location, hostName, createdAt }

// نظام إحصائيات اللاعبين
const playerStats = new Map(); // username -> { wins, losses, points, gamesPlayed, lastGameDate, weeklyPoints, monthlyPoints }

function getOrCreateStats(username) {
    if (!playerStats.has(username)) {
        playerStats.set(username, {
            username,
            wins: 0,
            losses: 0,
            points: 0,
            gamesPlayed: 0,
            lastGameDate: Date.now(),
            weeklyPoints: 0,
            monthlyPoints: 0
        });
    }
    return playerStats.get(username);
}

async function getLeaderboard() {
    try {
        const weeklyResult = await pool.query(`
            SELECT username, COALESCE(weekly_points, 0) AS weekly_points
            FROM users
            ORDER BY COALESCE(weekly_points, 0) DESC, username ASC
            LIMIT 1
        `);

        const monthlyResult = await pool.query(`
            SELECT username, COALESCE(monthly_points, 0) AS monthly_points
            FROM users
            ORDER BY COALESCE(monthly_points, 0) DESC, username ASC
            LIMIT 1
        `);

        const winnerResult = await pool.query(`
            SELECT username, COALESCE(wins, 0) AS wins
            FROM users
            ORDER BY COALESCE(wins, 0) DESC, username ASC
            LIMIT 1
        `);

        const weekly = weeklyResult.rows[0];
        const monthly = monthlyResult.rows[0];
        const winner = winnerResult.rows[0];

        return {
            weekly: weekly
                ? { username: weekly.username, weeklyPoints: Number(weekly.weekly_points) || 0 }
                : { username: "—", weeklyPoints: 0 },

            monthly: monthly
                ? { username: monthly.username, monthlyPoints: Number(monthly.monthly_points) || 0 }
                : { username: "—", monthlyPoints: 0 },

            winner: winner
                ? { username: winner.username, wins: Number(winner.wins) || 0 }
                : { username: "—", wins: 0 }
        };
    } catch (err) {
        console.error("❌ LEADERBOARD DB ERROR:", err.message);
        return {
            weekly: { username: "—", weeklyPoints: 0 },
            monthly: { username: "—", monthlyPoints: 0 },
            winner: { username: "—", wins: 0 }
        };
    }
}

function createRoomId() {
    return "ROOM-" + Date.now() + "-" + Math.floor(Math.random() * 900 + 100);
}

function normalizeRoomId(roomId) {
    return String(roomId || "").trim().toUpperCase();
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            players: [],
            hostId: null,
            gameState: null,
            currentPlayer: 0,
            pendingCapture: null,
            objectionRank: null,
            objectionOwner: null,
            objectionPlayer: null,
            decks: 5
        });
    }

    return rooms.get(roomId);
}

function findPlayerByName(room, username) {
    return room.players.find(player =>
        !player.isBot &&
        player.username === username
    );
}

function emitRoomState(roomId, room) {
    io.to(roomId).emit("roomJoined", {
        roomId,
        players: room.players,
        playersCount: room.players.filter(Boolean).length
    });
}


app.post("/api/register", async (req, res) => {
    try {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "").trim();

        if (!username || !password) {
            return res.status(400).json({ message: "أدخل الاسم وكلمة المرور" });
        }

        if (username.length < 3) {
            return res.status(400).json({ message: "اسم المستخدم يجب أن يكون 3 أحرف على الأقل" });
        }

        if (password.length < 4) {
            return res.status(400).json({ message: "كلمة المرور يجب أن تكون 4 أحرف على الأقل" });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        await pool.query(
            "INSERT INTO users (username, password) VALUES ($1, $2)",
            [username, passwordHash]
        );

        res.json({ message: "تم إنشاء الحساب" });
    } catch (err) {
        if (err.code === "23505") {
            return res.status(400).json({ message: "الاسم مستخدم مسبقاً" });
        }

        console.error("❌ REGISTER ERROR:", err.message);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "").trim();

        if (!username || !password) {
            return res.status(400).json({ message: "أدخل الاسم وكلمة المرور" });
        }

        const result = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(400).json({ message: "الحساب غير موجود" });
        }

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(400).json({ message: "كلمة المرور غير صحيحة" });
        }

        const activeSession = await pool.query(
            "SELECT id FROM sessions WHERE user_id = $1 LIMIT 1",
            [user.id]
        );

        if (activeSession.rows.length > 0) {
            return res.status(403).json({
                message: "الحساب مستخدم حالياً من جهاز آخر. سجل خروجك من الجهاز الأول ثم حاول مرة ثانية."
            });
        }

        const sessionToken = uuidv4();

        await pool.query(
            "INSERT INTO sessions (user_id, session_token) VALUES ($1, $2)",
            [user.id, sessionToken]
        );

        const token = jwt.sign(
            { id: user.id, username: user.username, sessionToken },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: user.username
            }
        });
    } catch (err) {
        console.error("❌ LOGIN ERROR:", err.message);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});

app.post("/api/logout", async (req, res) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) return res.json({ ok: true });

        const data = jwt.verify(token, JWT_SECRET);

        await pool.query(
            "DELETE FROM sessions WHERE user_id = $1 AND session_token = $2",
            [data.id, data.sessionToken]
        );

        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: true });
    }
});

app.get("/api/me", async (req, res) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        const user = await verifyActiveSession(token);

        if (!user) {
            return res.status(401).json({ message: "الجلسة غير صالحة" });
        }

        res.json({ user: { id: user.id, name: user.username } });
    } catch (err) {
        res.status(401).json({ message: "الجلسة غير صالحة" });
    }
});

io.on("connection", (socket) => {
    console.log("لاعب دخل:", socket.id);

    socket.onAny((event, data) => {
        console.log("حدث وصل للسيرفر:", event, data?.roomId || "");
    });

    socket.on("syncGame", (data) => {
        const roomId = normalizeRoomId(data.roomId);
        const room = getRoom(roomId);
        for (let i = 0; i < 4; i++) {
            if (room.players[i] === undefined) room.players[i] = null;
        }
        if (!room) return;

        room.gameState = data.gameState;
        room.currentPlayer = data.currentPlayer;

        room.pendingCapture = data.pendingCapture || null;
        room.objectionRank = data.objectionRank || null;
        room.objectionOwner = data.objectionOwner ?? null;
        room.objectionPlayer = data.objectionPlayer ?? null;

        io.to(roomId).emit("gameSynced", {
            gameState: room.gameState,
            currentPlayer: room.currentPlayer,
            players: room.players,

            pendingCapture: room.pendingCapture,
            objectionRank: room.objectionRank,
            objectionOwner: room.objectionOwner,
            objectionPlayer: room.objectionPlayer,

            from: socket.id
        });
    });

    socket.on("createRoom", async (data) => {
        const roomId = normalizeRoomId(data?.roomId || createRoomId());
        const username = data?.username || `لاعب-${socket.id.slice(0, 4)}`;
        const avatar = data?.avatar || "images/default-avatar.png";

        console.log(`📍 createRoom: trying to create/access room ${roomId}`);

        const room = getRoom(roomId);
        console.log(`📊 Room players before: ${room.players.length}`);

        if (room.players.length === 0) {
            room.players.push({
                id: socket.id,
                username,
                avatar,
                disconnected: false
            });
            room.hostId = socket.id;
            console.log(`✅ First player added`);
        } else {
            const oldPlayer = findPlayerByName(room, username);

            if (oldPlayer) {
                oldPlayer.id = socket.id;
                oldPlayer.avatar = avatar;
                oldPlayer.disconnected = false;
                console.log(`✏️ Updated existing player: ${username}`);
            }
        }

        await socket.join(roomId);

        const playerIndex = room.players.findIndex((player) => player.id === socket.id);
        console.log(`🎮 createRoom: playerIndex = ${playerIndex} (total players: ${room.players.length})`);

        io.to(socket.id).emit("roomCreated", {
            roomId,
            playerIndex,
            players: room.players,
            playersCount: room.players.length,
            isHost: room.hostId === socket.id
        });

        if (room.gameState) {
            io.to(socket.id).emit("receiveGameState", {
                roomId,
                gameState: room.gameState,
                currentPlayer: room.currentPlayer,
                players: room.players,

                pendingCapture: room.pendingCapture,
                objectionRank: room.objectionRank,
                objectionOwner: room.objectionOwner,
                objectionPlayer: room.objectionPlayer
            });
        }
    });

    socket.on("joinRoom", async (data) => {
        const roomId = normalizeRoomId(data?.roomId);
        const username = data?.username || `لاعب-${socket.id.slice(0, 4)}`;
        const avatar = data?.avatar || "images/default-avatar.png";

        if (!roomId) {
            io.to(socket.id).emit("joinError", {
                message: "رمز الغرفة غير صحيح"
            });
            return;
        }

        // الحصول على الغرفة أو إنشاء واحدة جديدة
        const room = getRoom(roomId);
        
        if (!room) {
            io.to(socket.id).emit("joinError", {
                message: "لا يمكن الوصول إلى الغرفة"
            });
            return;
        }

        let playerIndex = -1;
        
        // ابحث عن لاعب موجود بـ socket.id (إعادة اتصال)
        const existingPlayerIndex = room.players.findIndex(p => p?.id === socket.id);

        if (existingPlayerIndex !== -1) {
            // نفس اللاعب يعاد الاتصال - تحديث البيانات فقط
            room.players[existingPlayerIndex].disconnected = false;
            room.players[existingPlayerIndex].username = username;
            room.players[existingPlayerIndex].avatar = avatar;
            playerIndex = existingPlayerIndex;
            console.log(`♻️ Player ${username} reconnected to room ${roomId}, index: ${playerIndex}`);
        } else {
            // نفس الحساب (نفس الاسم) يدخل من جديد: لا تنشئ مقعداً جديداً
            const sameNameIndex = room.players.findIndex(p =>
                p && !p.isBot && p.username === username
            );

            if (sameNameIndex !== -1) {
                const oldSocketId = room.players[sameNameIndex].id;
                room.players[sameNameIndex] = {
                    ...room.players[sameNameIndex],
                    id: socket.id,
                    username,
                    avatar,
                    disconnected: false
                };
                playerIndex = sameNameIndex;

                if (room.hostId === oldSocketId) {
                    room.hostId = socket.id;
                }

                if (oldSocketId && oldSocketId !== socket.id) {
                    const oldSocket = io.sockets.sockets.get(oldSocketId);
                    oldSocket?.leave(roomId);
                }

                console.log(`♻️ Player ${username} resumed seat ${playerIndex} in room ${roomId}`);
            } else {
            // لاعب جديد تماماً
            // التحقق من وجود بوت يمكن استبداله
            const botIndex = room.players.findIndex(p => p?.isBot);
            const occupiedCount = room.players.filter(Boolean).length;
            
            if (botIndex !== -1) {
                // استبدال البوت باللاعب الحقيقي
                room.players[botIndex] = {
                    id: socket.id,
                    username,
                    avatar,
                    disconnected: false
                };
                playerIndex = botIndex;
                console.log(`🤖➡️👤 Player ${username} replaced bot at index ${playerIndex} in room ${roomId}`);
            } else if (occupiedCount >= 4) {
                // الغرفة ممتلئة ولا توجد بوتات
                io.to(socket.id).emit("joinError", {
                    message: "الغرفة ممتلئة"
                });
                return;
            } else {
                // إضافة لاعب جديد
                const emptySeatIndex = [0, 1, 2, 3].find(index => !room.players[index]);
                const newPlayer = {
                    id: socket.id,
                    username,
                    avatar,
                    disconnected: false
                };

                if (emptySeatIndex !== undefined) {
                    room.players[emptySeatIndex] = newPlayer;
                    playerIndex = emptySeatIndex;
                } else {
                    room.players.push(newPlayer);
                    playerIndex = room.players.length - 1;
                }

                if (!room.hostId) room.hostId = socket.id;
                console.log(`🆕 Player ${username} joined room ${roomId}, index: ${playerIndex}`);
            }
            }
        }

        await socket.join(roomId);

        // إرسال roomJoined إلى اللاعب الجديد فقط مع index صحيح
        io.to(socket.id).emit("roomJoined", {
            roomId,
            playerIndex,
            players: room.players,
            playersCount: room.players.filter(Boolean).length,
            isHost: room.hostId === socket.id
        });

        // إبلاغ جميع اللاعبين في الغرفة بقائمة اللاعبين المحدثة (بما فيهم البوتات المستبدلة)
        socket.broadcast.to(roomId).emit("playerJoined", {
            roomId,
            players: room.players,
            playersCount: room.players.filter(Boolean).length
        });

        if (room.gameState) {
            io.to(socket.id).emit("receiveGameState", {
                roomId,
                gameState: room.gameState,
                currentPlayer: room.currentPlayer,
                players: room.players,

                pendingCapture: room.pendingCapture,
                objectionRank: room.objectionRank,
                objectionOwner: room.objectionOwner,
                objectionPlayer: room.objectionPlayer
            });
        }
    });

        socket.on("selectSeat", (data) => {
            const roomId = normalizeRoomId(data.roomId);
            const seatIndex = data.seatIndex;

            const room = rooms.get(roomId);
            if (!room) {
                socket.emit("joinError", { message: "الغرفة غير موجودة" });
                return;
            }

            for (let i = 0; i < 4; i++) {
                if (room.players[i] === undefined) room.players[i] = null;
            }

            // البحث عن اللاعب الحالي
            const playerIndex = room.players.findIndex(p => p?.id === socket.id);
            if (playerIndex === -1) {
                socket.emit("joinError", { message: "أنت لست في هذه الغرفة" });
                return;
            }

            // التحقق من أن المقعد المختار فارغ
            // التحقق من أن المقعد المختار فارغ وأنه ليس نفس المقعد
            if (seatIndex === playerIndex) {
                return; // نفس المقعد
            }
            if (room.players[seatIndex]) {
                socket.emit("gameMessage", "هذا المقعد مأهول بالفعل");
                return;
            }

            // نقل اللاعب إلى المقعد الجديد
            // نقل اللاعب إلى المقعد الجديد باستخدام null للمقاعد الفارغة
            const player = room.players[playerIndex];
            room.players[playerIndex] = null;
            room.players[seatIndex] = player;
        
            console.log(`✔️ Player ${player.username} moved to seat ${seatIndex + 1} in room ${roomId}`);
            console.log("📋 Updated players array:", room.players.map((p, i) => `${i}: ${p?.username || 'empty'}`).join(', '));

            // حساب عدد اللاعبين الفعليين
            const playersCount = room.players.filter(Boolean).length;

            // إرسال تحديث roomJoined للاعب المتحرك
            io.to(socket.id).emit("roomJoined", {
                roomId,
                playerIndex: seatIndex,
                players: room.players,
                playersCount: playersCount,
                isHost: room.hostId === socket.id
            });

            // إبلاغ جميع اللاعبين الآخرين بالتحديث
            socket.broadcast.to(roomId).emit("playerJoined", {
                roomId,
                players: room.players,
                playersCount: playersCount
            });
        });

    socket.on("findMatch", (data) => {
        const username = data?.username || `لاعب-${socket.id.slice(0, 4)}`;
        const avatar = data?.avatar || "images/default-avatar.png";

        if (!waitingPlayers.some((player) => player.id === socket.id)) {
            waitingPlayers.push({ id: socket.id, username, avatar });
        } else {
            waitingPlayers = waitingPlayers.map((player) =>
                player.id === socket.id ? { ...player, username, avatar } : player
            );
        }

        io.to(socket.id).emit("waiting", {
            count: waitingPlayers.length,
            message: "جارٍ البحث عن لاعبين..."
        });

        setTimeout(() => {
            const matchedPlayers = waitingPlayers.splice(0, 4);

            if (!matchedPlayers.some((player) => player.id === socket.id)) {
                return;
            }

            const roomId = createRoomId();
            const room = getRoom(roomId);

            room.players = matchedPlayers.map((player) => ({
                id: player.id,
                username: player.username,
                avatar: player.avatar || "images/default-avatar.png",
                disconnected: false
            }));

            matchedPlayers.forEach((player, index) => {
                const playerSocket = io.sockets.sockets.get(player.id);

                playerSocket?.join(roomId);
                playerSocket?.emit("matchFound", {
                    roomId,
                    playerIndex: index,
                    players: room.players,
                    playersCount: room.players.length,
                    botsCount: Math.max(0, 4 - room.players.length),
                    isHost: index === 0
                });
            });
        }, 1500);
    });

    socket.on("startManualRoom", (data) => {
        const roomId = normalizeRoomId(data.roomId);
        console.log("وصل طلب بدء المباراة:", roomId, "computersToAdd:", data.computersToAdd);

        const room = rooms.get(roomId);

        if (!room) {
            console.log("❌ الغرفة غير موجودة");
            return;
        }
        
        for (let i = 0; i < 4; i++) {
            if (room.players[i] === undefined) room.players[i] = null;
        }

        console.log("✅ الغرفة موجودة، عدد اللاعبين:", room.players.filter(Boolean).length);
        console.log("🎯 الهوست الحالي:", room.players[0]?.id, "الاتصال الحالي:", socket.id);
        
        if ((room.hostId || room.players[0]?.id) !== socket.id) {
            console.log("❌ ليس الهوست");
            return;
        }

        room.decks = data.decks || 5;

        // إضافة كمبيوتر تلقائياً للمقاعد الفارغة بناءً على العدد الفعلي
        const computersToAdd = Math.max(0, 4 - room.players.filter(Boolean).length);
        console.log(`➕ سيتم إضافة ${computersToAdd} كمبيوتر`);
        
        let botsAdded = 0;
        for (let i = 0; i < 4 && botsAdded < computersToAdd; i++) {
            if (room.players[i]) continue;

            const botNumber = room.players.filter(p => p?.isBot).length + 1;
            room.players[i] = {
                id: `bot-${roomId}-${Date.now()}-${i}`,
                username: `كمبيوتر ${botNumber}`,
                avatar: "images/default-avatar.png",
                isBot: true,
                disconnected: false
            };
            botsAdded += 1;
        }

        console.log(`✅ تم إضافة الكمبيوتر، عدد اللاعبين الآن: ${room.players.filter(Boolean).length}`);

        if (room.players.filter(Boolean).length < 4) {
            console.log("❌ عدد اللاعبين أقل من 4");
            socket.emit("gameMessage", "لازم يكتمل عدد اللاعبين 4");
            return;
        }

        console.log("سأرسل matchFound", roomId, "الرزمات:", room.decks);

        io.to(roomId).emit("matchFound", {
            roomId,
            players: room.players,
            playersCount: room.players.filter(Boolean).length,
            botsCount: room.players.filter(p => p?.isBot).length,
            isHost: room.hostId === socket.id,
            decks: room.decks
        });
    });

    socket.on("sendGameState", (data) => {
        const roomId = normalizeRoomId(data.roomId);
        const room = rooms.get(roomId);

        console.log("وصل توزيع اللعبة من الهوست:", roomId);

        if (!room) return;
        if ((room.hostId || room.players[0]?.id) !== socket.id) return;

        room.gameState = data.gameState;
        room.currentPlayer = data.gameState?.currentPlayer || 0;

        room.players.forEach((player) => {
            if (player.isBot) return;

            io.to(player.id).emit("receiveGameState", {
                roomId,
                gameState: room.gameState,
                currentPlayer: room.currentPlayer,
                players: room.players,

                pendingCapture: room.pendingCapture,
                objectionRank: room.objectionRank,
                objectionOwner: room.objectionOwner,
                objectionPlayer: room.objectionPlayer
            });
        });
    });

    socket.on("getPublicRooms", () => {
        const list = [];
        for (const [roomId, meta] of publicRooms.entries()) {
            const room = rooms.get(roomId);
            if (!room) continue;
            if (room.gameState) continue; // game already started
            const humanPlayers = room.players.filter(p => !p.isBot && !p.disconnected).length;
            if (humanPlayers >= 4) continue; // full
            list.push({
                roomId,
                title: meta.title,
                location: meta.location,
                hostName: meta.hostName,
                createdAt: meta.createdAt,
                playersCount: humanPlayers,
                spotsLeft: 4 - humanPlayers
            });
        }
        io.to(socket.id).emit("publicRoomsList", { rooms: list });
    });

    socket.on("createPublicRoom", async (data) => {
        try {
            // لا نحتاج إلى فحص currentUser على الخادم - البيانات تأتي من الـ client
            const roomId = normalizeRoomId(data?.roomId || createRoomId());
            const username = data?.username || `لاعب-${socket.id.slice(0, 4)}`;
            const avatar = data?.avatar || "images/default-avatar.png";
            const title = String(data?.title || "جلسة عامة").slice(0, 60);
            const location = String(data?.location || "").slice(0, 60);

            console.log("📢 Creating public room:", { roomId, username, title, location });

            const room = getRoom(roomId);

            if (room.players.length === 0) {
                room.players.push({ id: socket.id, username, avatar, disconnected: false });
                room.hostId = socket.id;
            }

            publicRooms.set(roomId, {
                title,
                location,
                hostName: username,
                createdAt: Date.now()
            });

            await socket.join(roomId);

            const playerIndex = room.players.findIndex(p => p?.id === socket.id);

            console.log("✅ Room created successfully:", roomId, "with host:", username);
            console.log("🎫 Sending roomCreated to socket:", socket.id, "playerIndex:", playerIndex);

            // إرسال roomCreated للمنشئ أولاً
            io.to(socket.id).emit("roomCreated", {
                roomId,
                playerIndex,
                players: room.players,
                playersCount: room.players.length,
                isHost: room.hostId === socket.id,
                isPublic: true
            });

            console.log("✅ roomCreated emit sent successfully");

            // تحديث قائمة الجلسات لجميع الـ clients
            const list = [];
            for (const [rid, meta] of publicRooms.entries()) {
                const r = rooms.get(rid);
                if (!r) continue;
                if (r.gameState) continue;
                const humanPlayers = r.players.filter(p => p && !p.isBot && !p.disconnected).length;
                if (humanPlayers >= 4) continue;
                list.push({
                    roomId: rid,
                    title: meta.title,
                    location: meta.location,
                    hostName: meta.hostName,
                    createdAt: meta.createdAt,
                    playersCount: humanPlayers,
                    spotsLeft: 4 - humanPlayers
                });
            }
            
            io.emit("publicRoomsList", { rooms: list });
            console.log("📤 Broadcast updated room list to all clients. Total rooms:", list.length);
        } catch (error) {
            console.error("❌ Error in createPublicRoom:", error.message, error.stack);
            io.to(socket.id).emit("gameMessage", "حدث خطأ في إنشاء الجلسة");
        }
    });

    socket.on("addComputer", (roomId) => {
        console.log("وصل طلب إضافة كمبيوتر:", roomId, socket.id);

        roomId = normalizeRoomId(roomId);
        const room = rooms.get(roomId);

        if (!room) {
            console.log("الغرفة غير موجودة");
            return;
        }

        if (room.players.length >= 4) return;

        const isHost = room.players[0]?.id === socket.id;
        if (!isHost) return;

        const botNumber = room.players.length + 1;

        room.players.push({
            id: "bot-" + roomId + "-" + botNumber,
            username: "كمبيوتر " + botNumber,
            avatar: "images/default-avatar.png",
            isBot: true,
            disconnected: false
        });

        emitRoomState(roomId, room);
    });

    socket.on("gameEnded", async (data) => {
        try {
            // data = { winner: username, players: [{ username, points, isWinner }, ...] }
            if (!data || !Array.isArray(data.players)) return;

            const winnerName = data.winner || "";

            for (const p of data.players) {
                const username = String(p.username || "").trim();

                if (!username || username.includes("كمبيوتر")) {
                    continue; // تجاهل البوتات
                }

                const gainedPoints = Number(p.points || 0);
                const isWinner = username === winnerName || p.isWinner === true;

                const result = await pool.query(
                    "SELECT id FROM users WHERE username = $1",
                    [username]
                );

                if (result.rows.length === 0) {
                    console.log(`⚠️ اللاعب غير موجود في قاعدة البيانات: ${username}`);
                    continue;
                }

                await pool.query(
                    `
                    UPDATE users
                    SET
                        games_played = COALESCE(games_played, 0) + 1,
                        points = COALESCE(points, 0) + $1,
                        weekly_points = COALESCE(weekly_points, 0) + $1,
                        monthly_points = COALESCE(monthly_points, 0) + $1,
                        wins = COALESCE(wins, 0) + $2,
                        losses = COALESCE(losses, 0) + $3,
                        last_game_at = NOW()
                    WHERE username = $4
                    `,
                    [
                        gainedPoints,
                        isWinner ? 1 : 0,
                        isWinner ? 0 : 1,
                        username
                    ]
                );

                console.log(`📊 تم حفظ إحصائيات ${username}: +${gainedPoints} نقطة`);
            }

            io.emit("leaderboardUpdated");
        } catch (error) {
            console.error("❌ Error in gameEnded:", error.message);
        }
    });

    socket.on("getLeaderboard", async () => {
        const leaderboard = await getLeaderboard();
        console.log("📋 Sending leaderboard:", leaderboard);
        io.to(socket.id).emit("leaderboardData", leaderboard);
    });

    socket.on("chatMessage", (data) => {
        const { roomId, username, message } = data;
        if (!roomId || !message) return;

        const room = rooms.get(roomId);
        if (!room) return;

        console.log(`💬 [${roomId}] ${username}: ${message}`);

        // بث الرسالة لجميع اللاعبين في الغرفة (بما فيهم المرسل)
        io.to(roomId).emit("chatMessage", {
            username,
            message,
            time: Date.now()
        });
    });

    socket.on("leaveWaitingRoom", (data) => {
        const roomId = normalizeRoomId(data?.roomId);
        const isHost = data?.isHost === true;

        console.log(`👤 Player leaving room ${roomId}, isHost: ${isHost}`);

        const room = rooms.get(roomId);
        if (!room) return;

        // إذا كان الخارج هوست، احذف الغرفة وأخبر جميع اللاعبين
        if (isHost) {
            console.log(`🔴 Host left room ${roomId} - closing room`);
            
            // أخبر جميع اللاعبين أن الغرفة أُغلقت
            io.to(roomId).emit("roomClosed", {
                message: "غادر منشئ الغرفة - تم إغلاق الغرفة"
            });

            // احذف الغرفة
            rooms.delete(roomId);
            publicRooms.delete(roomId);
            return;
        }

        // إذا لم يكن هوست، فقط أزل اللاعب من قائمة الغرفة
        const playerIndex = room.players.findIndex(p => p?.id === socket.id);
        if (playerIndex !== -1) {
            room.players[playerIndex] = null;
            console.log(`✔️ Player removed from room ${roomId}, remaining: ${room.players.filter(Boolean).length}`);
        }
    });

    socket.on("disconnect", () => {
        console.log("لاعب خرج:", socket.id);

        waitingPlayers = waitingPlayers.filter((player) => player.id !== socket.id);

        for (const [roomId, room] of rooms.entries()) {
            const player = room.players.find((p) => p?.id === socket.id);

            if (!player) continue;

            player.disconnected = true;

            io.to(roomId).emit("gameSynced", {
                gameState: room.gameState,
                currentPlayer: room.currentPlayer,
                players: room.players,

                pendingCapture: room.pendingCapture,
                objectionRank: room.objectionRank,
                objectionOwner: room.objectionOwner,
                objectionPlayer: room.objectionPlayer
            });

            setTimeout(() => {
                const samePlayer = room.players.find((p) => p?.id === socket.id);

                if (!samePlayer || !samePlayer.disconnected) return;

                    const removedIndex = room.players.findIndex((p) => p?.id === socket.id);
                    if (removedIndex !== -1) {
                        room.players[removedIndex] = null;
                    }

                    if (room.hostId === socket.id) {
                        room.hostId = room.players.find((p) => p)?.id || null;
                    }

                    if (room.players.filter(Boolean).length === 0) {
                    rooms.delete(roomId);
                    publicRooms.delete(roomId);
                    return;
                }

                io.to(roomId).emit("gameSynced", {
                    gameState: room.gameState,
                    currentPlayer: room.currentPlayer,
                    players: room.players,

                    pendingCapture: room.pendingCapture,
                    objectionRank: room.objectionRank,
                    objectionOwner: room.objectionOwner,
                    objectionPlayer: room.objectionPlayer
                });
            }, 30000);
        }
    });
});

// معالج الأخطاء العام
process.on("uncaughtException", (error) => {
    console.error("❌ UNCAUGHT EXCEPTION:", error.message);
    console.error(error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ UNHANDLED REJECTION:", reason);
});

const initialPort = Number(process.env.PORT) || 3000;
const maxPortRetries = process.env.PORT ? 0 : 10;
let currentPort = initialPort;
let retriedPorts = 0;

server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE" && retriedPorts < maxPortRetries) {
        const busyPort = currentPort;
        retriedPorts += 1;
        currentPort = busyPort + 1;
        console.warn(`⚠️ المنفذ ${busyPort} مستخدم، سيتم المحاولة على ${currentPort}...`);
        setTimeout(() => server.listen(currentPort), 150);
        return;
    }

    if (error && error.code === "EADDRINUSE") {
        console.error(`⚠️ تعذر تشغيل الخادم. جرب تحديد PORT يدويًا بدل ${currentPort}.`);
        process.exit(1);
    }

    console.error("❌ SERVER ERROR:", error);
    process.exit(1);
});

server.listen(currentPort, () => {
    console.log(`الخادم يعمل على http://localhost:${currentPort}`);
});
