const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let waitingPlayers = [];
const rooms = new Map();

function createRoomId() {
    return "room-" + Date.now() + "-" + Math.floor(Math.random() * 900 + 100);
}

function normalizeRoomId(roomId) {
    return String(roomId || "").trim().toUpperCase();
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            players: [],
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
        playersCount: room.players.length
    });
}

io.on("connection", (socket) => {
    console.log("لاعب دخل:", socket.id);

    socket.onAny((event, data) => {
        console.log("حدث وصل للسيرفر:", event, data?.roomId || "");
    });

    socket.on("syncGame", (data) => {
        const roomId = normalizeRoomId(data.roomId);
        const room = getRoom(roomId);
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

        const room = getRoom(roomId);

        if (room.players.length === 0) {
            room.players.push({
                id: socket.id,
                username,
                avatar,
                disconnected: false
            });
        } else {
            const oldPlayer = findPlayerByName(room, username);

            if (oldPlayer) {
                oldPlayer.id = socket.id;
                oldPlayer.avatar = avatar;
                oldPlayer.disconnected = false;
            }
        }

        await socket.join(roomId);

        const playerIndex = room.players.findIndex((player) => player.id === socket.id);

        io.to(socket.id).emit("roomCreated", {
            roomId,
            playerIndex,
            players: room.players,
            playersCount: room.players.length,
            isHost: playerIndex === 0
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

        if (!roomId || !rooms.has(roomId)) {
            io.to(socket.id).emit("joinError", {
                message: "رمز الغرفة غير صحيح أو غير موجود"
            });
            return;
        }

        const room = rooms.get(roomId);

        let playerIndex = -1;
        const oldPlayer = findPlayerByName(room, username);

        if (oldPlayer) {
            oldPlayer.id = socket.id;
            oldPlayer.avatar = avatar;
            oldPlayer.disconnected = false;
            playerIndex = room.players.findIndex((player) => player.username === username && !player.isBot);
        } else {
            if (room.players.length >= 4) {
                io.to(socket.id).emit("joinError", {
                    message: "الغرفة ممتلئة"
                });
                return;
            }

            room.players.push({
                id: socket.id,
                username,
                avatar,
                disconnected: false
            });

            playerIndex = room.players.length - 1;
        }

        await socket.join(roomId);

        io.to(roomId).emit("roomJoined", {
            roomId,
            playerIndex,
            players: room.players,
            playersCount: room.players.length,
            isHost: playerIndex === 0
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

    socket.on("quickPlay", (data) => {
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
        console.log("وصل طلب بدء المباراة:", roomId);

        const room = rooms.get(roomId);

        if (!room) return;
        if (room.players[0]?.id !== socket.id) return;

        room.decks = data.decks || 5;

        if (room.players.length < 4) {
            socket.emit("gameMessage", "لازم يكتمل عدد اللاعبين 4");
            return;
        }

        console.log("سأرسل matchFound", roomId, "الرزمات:", room.decks);

        io.to(roomId).emit("matchFound", {
            roomId,
            players: room.players,
            playersCount: room.players.length,
            botsCount: room.players.filter(p => p.isBot).length,
            isHost: true,
            decks: room.decks
        });
    });

    socket.on("sendGameState", (data) => {
        const roomId = normalizeRoomId(data.roomId);
        const room = rooms.get(roomId);

        console.log("وصل توزيع اللعبة من الهوست:", roomId);

        if (!room) return;
        if (room.players[0]?.id !== socket.id) return;

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

    socket.on("disconnect", () => {
        console.log("لاعب خرج:", socket.id);

        waitingPlayers = waitingPlayers.filter((player) => player.id !== socket.id);

        for (const [roomId, room] of rooms.entries()) {
            const player = room.players.find((p) => p.id === socket.id);

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
                const samePlayer = room.players.find((p) => p.id === socket.id);

                if (!samePlayer || !samePlayer.disconnected) return;

                room.players = room.players.filter((p) => p.id !== socket.id);

                if (room.players.length === 0) {
                    rooms.delete(roomId);
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

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`الخادم يعمل على http://localhost:${PORT}`);
});
