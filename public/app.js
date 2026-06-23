const socket = io();

let selectedCard = null;
let selectedCardData = null;
let selectedCardIndex = null;
let gameState = null;
let currentPlayer = 0;
let objectionTimer = null;
let objectionSeconds = 0;
let pendingStack = null;
let objectionRank = null;
let objectionOwner = null;
let pendingCapture = null;
let objectionPlayer = null;
let onlineRoomId = null;
let myOnlineIndex = 0;
let currentUser = null;
let onlineRoomPlayers = [];
let isRoomHost = false;
let botThinking = false;
let selectedDecks = 1;
let roundEnded = false;
let chatMessages = [];


const AUTH_STORAGE_KEY = "mujabeedUser";
const TOKEN_STORAGE_KEY = "mujabeedToken";

function getAuthToken() {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

function saveAuthSession(user, token) {
    currentUser = user;
    if (token) {
        currentUser.token = token;
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(currentUser));
}

function clearAuthSession() {
    currentUser = null;
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function apiRequest(url, options = {}) {
    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };

    const token = getAuthToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
        ...options,
        headers
    });

    let data = {};
    try {
        data = await response.json();
    } catch (e) {
        data = {};
    }

    if (!response.ok) {
        throw new Error(data.message || "حدث خطأ في الاتصال");
    }

    return data;
}

function setButtonLoading(button, isLoading, loadingText = "جاري التنفيذ...") {
    if (!button) return;

    if (isLoading) {
        button.dataset.oldText = button.textContent;
        button.disabled = true;
        button.textContent = loadingText;
    } else {
        button.disabled = false;
        if (button.dataset.oldText) {
            button.textContent = button.dataset.oldText;
        }
    }
}


function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function sendChatMessage() {
    const input = document.getElementById("chat-input");
    if (!input) {
        console.warn("⚠️ chat-input element not found");
        return;
    }
    const text = input.value.trim().slice(0, 200);
    if (!text) return;
    input.value = "";
    if (!onlineRoomId) {
        console.warn("⚠️ Not in online room");
        return;
    }
    const username = currentUser?.name || "لاعب";
    console.log("📤 Sending chat message:", text);
    
    // الخادم سيبث الرسالة لجميع اللاعبين (لا نضيفها هنا لتجنب التكرار)
    socket.emit("chatMessage", {
        roomId: onlineRoomId,
        username: username,
        message: text
    });
}

function appendChatMessage(msg, skipSave = false) {
    if (!msg || !msg.message) {
        console.warn("⚠️ Invalid message:", msg);
        return;
    }
    
    if (!skipSave) {
        chatMessages.push(msg);
    }
    
    const box = document.getElementById("chat-messages");
    if (!box) {
        console.warn("⚠️ chat-messages element not found. Trying after small delay...");
        setTimeout(() => appendChatMessage(msg, true), 100);
        return;
    }
    
    const isMe = msg.username === (currentUser?.name || "");
    const time = msg.time ? new Date(msg.time).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : "";
    
    const div = document.createElement("div");
    div.className = "chat-msg" + (isMe ? " chat-msg-me" : "");
    div.innerHTML = `
        <span class="chat-msg-name">${escapeHtml(msg.username)}</span>
        <span class="chat-msg-text">${escapeHtml(msg.message)}</span>
        ${time ? `<span class="chat-msg-time">${time}</span>` : ""}
    `;
    
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    console.log("💬 Chat message added:", msg.username, "-", msg.message);
}

function saveLastRoom() {
    if (!onlineRoomId) return;
    localStorage.setItem("lastRoomId", String(onlineRoomId).toUpperCase());
}

function clearLastRoom() {
    localStorage.removeItem("lastRoomId");
}

let soundEnabled = localStorage.getItem("mujabeedSound") !== "off";
let audioContext = null;

function getAudioContext() {
    if (!soundEnabled) return null;

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (audioContext.state === "suspended") {
        audioContext.resume();
    }

    return audioContext;
}

function playTone(frequency = 440, duration = 0.08, type = "sine", volume = 0.06) {
    const ctx = getAudioContext();
    if (!ctx) return;

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
}

function playSound(name = "click") {
    if (!soundEnabled) return;

    const sounds = {
        click: () => playTone(520, 0.045, "triangle", 0.035),
        card: () => playTone(720, 0.055, "square", 0.035),
        draw: () => {
            playTone(430, 0.05, "triangle", 0.04);
            setTimeout(() => playTone(620, 0.04, "triangle", 0.03), 45);
        },
        capture: () => {
            playTone(560, 0.06, "triangle", 0.045);
            setTimeout(() => playTone(760, 0.06, "triangle", 0.035), 60);
        },
        objection: () => {
            playTone(880, 0.08, "sawtooth", 0.045);
            setTimeout(() => playTone(520, 0.08, "sawtooth", 0.035), 80);
        },
        win: () => {
            playTone(523, 0.12, "triangle", 0.045);
            setTimeout(() => playTone(659, 0.12, "triangle", 0.045), 130);
            setTimeout(() => playTone(784, 0.18, "triangle", 0.045), 260);
        },
        error: () => playTone(180, 0.1, "sawtooth", 0.035)
    };

    (sounds[name] || sounds.click)();
}

function toggleSound() {
    soundEnabled = !soundEnabled;
    localStorage.setItem("mujabeedSound", soundEnabled ? "on" : "off");
    playSound("click");
    showMessage(soundEnabled ? "تم تشغيل الصوت" : "تم إيقاف الصوت");
}

function getStatsStore() {
    try {
        return JSON.parse(localStorage.getItem("mujabeedStats") || "{}");
    } catch (e) {
        return {};
    }
}

function saveStatsStore(stats) {
    localStorage.setItem("mujabeedStats", JSON.stringify(stats));
}

function getUserStats(username = currentUser?.name) {
    const store = getStatsStore();
    if (!username) return { gamesPlayed: 0, objections: 0 };

    return store[username] || { gamesPlayed: 0, objections: 0 };
}

function updateUserStats(username = currentUser?.name, updates = {}) {
    if (!username) return;

    const store = getStatsStore();
    const current = store[username] || { gamesPlayed: 0, objections: 0 };

    const next = {
        ...current,
        ...updates
    };

    store[username] = next;
    saveStatsStore(store);
}

function recordGameStart() {
    if (!currentUser?.name) return;
    updateUserStats(currentUser.name, {
        gamesPlayed: getUserStats(currentUser.name).gamesPlayed + 1
    });
}

function recordObjectionUse() {
    if (!currentUser?.name) return;
    updateUserStats(currentUser.name, {
        objections: getUserStats(currentUser.name).objections + 1
    });
}

function shareGame() {
    const text = onlineRoomId
        ? `انضم إلى غرفة مجابيد: ${onlineRoomId}`
        : "انضم إلى مباراة مجابيد";

    playSound("click");

    if (navigator.share) {
        navigator.share({
            title: "مجابيد",
            text: text
        }).catch(() => {
            showMessage("تم إغلاق المشاركة");
        });
        return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showMessage("تم نسخ نص المشاركة"))
            .catch(() => showMessage("لا يمكن نسخ النص الآن"));
        return;
    }

    showMessage("يمكنك نسخ نص المشاركة يدويًا");
}

function showHelpModal() {
    playSound("click");

    const overlay = document.createElement("div");
    overlay.className = "help-overlay";
    overlay.id = "help-overlay";
    overlay.innerHTML = `
        <div class="help-modal">
            <button class="help-close" onclick="this.parentElement.parentElement.remove()">×</button>
            <h3>دليل اللعب</h3>
            <ul>
                <li>اختر ورقة ثم اضغط على زر تنزيل أو سحب.</li>
                <li>يمكنك الاعتراض عند ظهور الإشارة.</li>
                <li>استخدم زر المشاركة لمشاركة رمز الغرفة مع اللاعبين.</li>
            </ul>
        </div>
    `;

    document.body.appendChild(overlay);
}

document.addEventListener("click", (event) => {
    if (event.target.closest("button")) {
        playSound("click");
    }
});

function showEntryPage() {
    document.body.innerHTML = `
        <div class="entry-screen">
            <div class="entry-card">
                <div class="entry-logo">مجابيد</div>
                <h1>مجابيد</h1>
                <p>لعبة ورق جماعية أونلاين</p>

                <div class="entry-actions">
                    <button onclick="showLoginPage()">تسجيل الدخول</button>
                    <button onclick="showRegisterPage()">إنشاء حساب</button>
                    <button onclick="continueAsGuest()">الدخول كضيف</button>
                </div>
            </div>
        </div>
    `;
}

function continueAsGuest() {
    const guestId = Math.floor(Math.random() * 9000 + 1000);
    currentUser = {
        id: null,
        name: "ضيف " + guestId,
        isGuest: true
    };

    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(currentUser));
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    showMainMenu();
}



function createRoom() {
    if (!currentUser) {
        showLoginPage();
        return;
    }

    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    for (let i = 0; i < 5; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }

    socket.emit("createRoom", {
        roomId: code,
        username: currentUser.name
    });
}

function showLoginPage() {
    document.body.innerHTML = `
        <div class="login-screen">
            <div class="login-card">
                <h1>مجابيد</h1>
                <p class="login-subtitle">أدخل بياناتك للمتابعة</p>

                <div class="auth-form-block" id="loginSection">
                    <h2>تسجيل الدخول</h2>
                    <form onsubmit="event.preventDefault(); loginUser();">
                        <input id="loginName" type="text" placeholder="اسم المستخدم" required>
                        <input id="loginPassword" type="password" placeholder="كلمة المرور" required>
                        <button type="submit">دخول</button>
                    </form>
                    <button type="button" class="secondary-btn" onclick="showEntryPage()">رجوع</button>
                    <p id="loginError" class="login-error"></p>
                    <p class="switch-auth">
                        ليس لديك حساب؟
                        <button type="button" class="link-button" onclick="showRegisterPage()">تسجيل</button>
                    </p>
                </div>
            </div>
        </div>
    `;
}

function showRegisterPage() {
    document.body.innerHTML = `
        <div class="login-screen">
            <div class="login-card">
                <h1>مجابيد</h1>
                <p class="login-subtitle">أنشئ حسابًا جديدًا</p>

                <div class="auth-form-block" id="registerSection">
                    <h2>إنشاء حساب جديد</h2>
                    <form onsubmit="event.preventDefault(); registerUser();">
                        <input id="registerName" type="text" placeholder="اسم المستخدم" required>
                        <input id="registerPassword" type="password" placeholder="كلمة المرور" required>
                        <button type="submit">تسجيل</button>
                    </form>
                    <button type="button" class="secondary-btn" onclick="showEntryPage()">رجوع</button>
                    <p id="registerError" class="login-error"></p>
                    <p class="switch-auth">
                        لديك حساب بالفعل؟
                        <button type="button" class="link-button" onclick="showLoginPage()">دخول</button>
                    </p>
                </div>
            </div>
        </div>
    `;
}

async function loginUser() {
    const name = document.getElementById("loginName")?.value.trim();
    const password = document.getElementById("loginPassword")?.value.trim();
    const errorBox = document.getElementById("loginError");
    const submitBtn = document.querySelector("#loginSection button[type='submit']");

    if (errorBox) errorBox.textContent = "";

    if (!name || !password) {
        if (errorBox) errorBox.textContent = "يرجى إدخال الاسم وكلمة المرور";
        return;
    }

    try {
        setButtonLoading(submitBtn, true, "جاري الدخول...");

        const data = await apiRequest("/api/login", {
            method: "POST",
            body: JSON.stringify({
                username: name,
                password
            })
        });

        saveAuthSession(data.user, data.token);
        showMainMenu();
    } catch (err) {
        if (errorBox) errorBox.textContent = err.message || "تعذر تسجيل الدخول";
    } finally {
        setButtonLoading(submitBtn, false);
    }
}


async function registerUser() {
    const name = document.getElementById("registerName")?.value.trim();
    const password = document.getElementById("registerPassword")?.value.trim();
    const errorBox = document.getElementById("registerError");
    const submitBtn = document.querySelector("#registerSection button[type='submit']");

    if (errorBox) {
        errorBox.textContent = "";
        errorBox.style.color = "";
    }

    if (!name || !password) {
        if (errorBox) errorBox.textContent = "يرجى إدخال الاسم وكلمة المرور";
        return;
    }

    if (password.length < 4) {
        if (errorBox) errorBox.textContent = "كلمة المرور يجب أن تكون 4 أحرف على الأقل";
        return;
    }

    try {
        setButtonLoading(submitBtn, true, "جاري التسجيل...");

        await apiRequest("/api/register", {
            method: "POST",
            body: JSON.stringify({
                username: name,
                password
            })
        });

        if (errorBox) {
            errorBox.style.color = "#16a34a";
            errorBox.textContent = "تم إنشاء الحساب بنجاح، يمكنك تسجيل الدخول الآن";
        }

        setTimeout(() => {
            showLoginPage();
            const loginName = document.getElementById("loginName");
            if (loginName) loginName.value = name;
        }, 900);
    } catch (err) {
        if (errorBox) {
            errorBox.style.color = "";
            errorBox.textContent = err.message || "تعذر إنشاء الحساب";
        }
    } finally {
        setButtonLoading(submitBtn, false);
    }
}


function showMainMenu() {
    const userName = currentUser?.name || "اللاعب";

    document.body.innerHTML = `
        <div class="main-menu-screen">
            <div class="main-menu-shell">
                <header class="main-menu-header">
                    <div>
                        <p class="menu-badge">مجابيد</p>
                        <h1>مرحباً، ${userName}</h1>
                    </div>
                    <button class="menu-icon-btn" onclick="showSettings()" aria-label="الإعدادات">الإعدادات</button>
                </header>

                <section class="main-menu-hero">
                    <div>
                        <span class="hero-pill">لعب جماعي</span>
                        <h2>ابدأ مباراة جديدة الآن</h2>
                    </div>
                    <button class="hero-play-btn" onclick="quickPlayOnline()">ابدأ اللعب</button>
                </section>

                <section class="leaderboard-section">
                    <h3 style="margin:0 0 12px; font-size:0.95rem; opacity:0.8; letter-spacing:0.3px;">🏆 لوحة المتصدرين</h3>
                    
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:16px;">
                        <!-- أفضل لاعب أسبوعياً -->
                        <div class="leaderboard-card">
                            <div style="font-size:0.8rem; opacity:0.7; margin-bottom:8px;">📅 هذا الأسبوع</div>
                            <div style="font-weight:800; font-size:1.1rem; margin-bottom:4px;" id="weekly-name">—</div>
                            <div style="font-size:0.9rem; opacity:0.8;" id="weekly-points">0 نقطة</div>
                        </div>
                        
                        <!-- أفضل لاعب شهرياً -->
                        <div class="leaderboard-card">
                            <div style="font-size:0.8rem; opacity:0.7; margin-bottom:8px;">📆 هذا الشهر</div>
                            <div style="font-weight:800; font-size:1.1rem; margin-bottom:4px;" id="monthly-name">—</div>
                            <div style="font-size:0.9rem; opacity:0.8;" id="monthly-points">0 نقطة</div>
                        </div>
                        
                        <!-- أكثر اللاعبين فوزاً -->
                        <div class="leaderboard-card">
                            <div style="font-size:0.8rem; opacity:0.7; margin-bottom:8px;">🎯 الأكثر فوزاً</div>
                            <div style="font-weight:800; font-size:1.1rem; margin-bottom:4px;" id="winner-name">—</div>
                            <div style="font-size:0.9rem; opacity:0.8;" id="winner-wins">0 انتصار</div>
                        </div>
                    </div>
                </section>

                <section class="menu-grid">
                    <button class="menu-card" onclick="createRoom()">
                        <span class="menu-card-icon">إنشاء</span>
                        <span>إنشاء غرفة</span>
                    </button>
                    <button class="menu-card" onclick="showJoinByCode()">
                        <span class="menu-card-icon">رمز</span>
                        <span>الانضمام برمز</span>
                    </button>
                    <button class="menu-card" onclick="showRealPlayers()">
                        <span class="menu-card-icon">لاعبون</span>
                        <span>لاعبون حقيقيون</span>
                    </button>
                    <button class="menu-card" onclick="logoutUser()">
                        <span class="menu-card-icon">خروج</span>
                        <span>تسجيل الخروج</span>
                    </button>
                </section>
            </div>

            <div id="roomBox"></div>
            <div id="waitingBox" style="display:none;">
                <div class="waiting-card">
                    <h2>البحث عن لاعبين...</h2>
                    <p id="waitingCount">0 / 4</p>
                </div>
            </div>
        </div>
    `;

    // طلب بيانات لوحة المتصدرين من الخادم
    socket.emit("getLeaderboard");
}


function showSettings() {
    document.body.innerHTML = `
        <div class="entry-screen">
            <div class="entry-card settings-card">
                <div class="entry-logo">الإعدادات</div>
                <h1>الإعدادات</h1>

                <button onclick="toggleSound()">
                    ${soundEnabled ? "إيقاف الصوت" : "تشغيل الصوت"}
                </button>

                <button onclick="clearSavedGame(); clearLastRoom(); showMainMenu();">
                    حذف حفظ المباراة
                </button>

                <button class="secondary-btn" onclick="showMainMenu()">رجوع</button>
            </div>
        </div>
    `;
}


async function logoutUser() {
    try {
        const token = getAuthToken();
        if (token) {
            await apiRequest("/api/logout", {
                method: "POST"
            });
        }
    } catch (e) {
        console.warn("تعذر تسجيل الخروج من السيرفر:", e.message);
    }

    clearAuthSession();
    clearSavedGame();
    clearLastRoom();
    showLoginPage();
}


function showJoinByCode() {
    document.body.innerHTML = `
        <div class="join-code-screen">
            <div class="join-code-card">
                <p class="join-code-badge">الدخول السريع</p>
                <h2>الانضمام برمز الغرفة</h2>
                <p class="join-code-subtitle">اكتب الرمز كما وصلك من صاحب الغرفة</p>

                <div class="join-code-form">
                    <label class="join-code-label" for="joinCodeInput">رمز الغرفة</label>
                    <input id="joinCodeInput" class="join-code-input" type="text" placeholder="مثال: A7K2M" maxlength="20" autocomplete="off" spellcheck="false">
                    <p class="join-code-hint">سيتم تحويل الحروف تلقائياً إلى أحرف كبيرة</p>
                </div>

                <div class="join-code-actions">
                    <button class="join-primary-btn" onclick="joinRoomByCode()">انضمام الآن</button>
                    <button class="secondary-btn join-secondary-btn" onclick="showMainMenu()">رجوع للقائمة</button>
                </div>

                <p id="joinCodeError" class="login-error join-code-error"></p>
            </div>
        </div>
    `;

    const input = document.getElementById("joinCodeInput");
    if (input) {
        input.focus();
        input.addEventListener("input", () => {
            input.value = input.value.toUpperCase();
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                joinRoomByCode();
            }
        });
    }
}

function joinRoomByCode() {
    const code = document.getElementById("joinCodeInput")?.value.trim();
    const normalizedCode = (code || "").toUpperCase();
    const errorBox = document.getElementById("joinCodeError");

    if (!normalizedCode) {
        if (errorBox) errorBox.textContent = "يرجى إدخال رمز الغرفة";
        return;
    }

    if (!currentUser) {
        showLoginPage();
        return;
    }

    if (errorBox) errorBox.textContent = "جاري الانضمام...";

    const timeoutId = setTimeout(() => {
        if (errorBox && errorBox.textContent === "جاري الانضمام...") {
            errorBox.textContent = "";
            showMessage("لم يتم الرد من السيرفر، يرجى التحقق من الرمز", 4000);
        }
    }, 8000);


    socket.once("joinError", (data) => {
        clearTimeout(timeoutId);
        if (errorBox) {
            errorBox.textContent = data?.message || "تعذر الانضمام إلى الغرفة";
        }
        showMessage(data?.message || "تعذر الانضمام إلى الغرفة", 4000);
    });

    socket.emit("joinRoom", {
        roomId: normalizedCode,
        username: currentUser.name
    });
}



function leaveWaitingRoom() {
    if (onlineRoomId) {
        socket.emit("leaveWaitingRoom", {
            roomId: onlineRoomId,
            isHost: isRoomHost
        });
    }
    clearLastRoom();
    onlineRoomId = null;
    onlineRoomPlayers = [];
    myOnlineIndex = 0;
    isRoomHost = false;
    showMainMenu();
}

function showLobby(code, players = onlineRoomPlayers, hostFlag = isRoomHost) {
    const normalizedRoomCode = String(code || onlineRoomId || "").toUpperCase();
    const members = Array.isArray(players) ? players : [];
    const realPlayersCount = members.filter(player => player !== null).length;

    const isHost = hostFlag === true || members[0]?.id === socket.id;

    const seatsHtml = [0, 1, 2, 3].map(i => {
        const player = members[i];
        const isMe = myOnlineIndex === i;
        
        // تحديد الفريق: 1 و 3 للفريق الأول، 2 و 4 للفريق الثاني
        const team = (i === 0 || i === 2) ? "فريق-1" : "فريق-2";
        const teamLabel = (i === 0 || i === 2) ? "الفريق الأول" : "الفريق الثاني";

        if (!player) {
            // مقعد فارغ - يمكن الضغط عليه لاختيار المقعد
            return `
                <div class="seat-item empty-seat ${team}">
                    <span class="seat-number">${i + 1}</span>
                    <span class="seat-team">${teamLabel}</span>
                    <button class="seat-select-btn" onclick="selectSeat(${i})" title="اختر هذا المقعد">اختر</button>
                </div>
            `;
        }

        const type = player.isBot ? "🤖 كمبيوتر" : "👤";
        const meTag = isMe ? "<span class='seat-tag'>أنت</span>" : "";

        return `
            <div class="seat-item occupied-seat ${team} ${isMe ? 'my-seat' : ''}">
                <span class="seat-number">${i + 1}</span>
                <span class="seat-team">${teamLabel}</span>
                <div>
                    <strong>${player.username}</strong>
                    <small>${type}${meTag}</small>
                </div>
            </div>
        `;
    }).join("");

    document.body.innerHTML = `
        <div id="waitingRoom" class="waiting-room-screen">
            <div class="waiting-room-card">
                <div class="waiting-room-header">
                    <div>
                        <p class="menu-badge">غرفة الانتظار</p>
                        <h1>${normalizedRoomCode}</h1>
                    </div>
                    <button class="menu-icon-btn" onclick="leaveWaitingRoom()" aria-label="خروج">خروج</button>
                </div>

                <div class="waiting-room-body">
                    <div class="waiting-room-info">
                        <span>عدد اللاعبين</span>
                        <strong>${realPlayersCount}/4</strong>
                    </div>

                    <div class="waiting-room-seats">
                        ${seatsHtml}
                    </div>

                    ${isHost ? `
                        <div class="deck-select">
                            <h3>اختر عدد الرزمات</h3>
                            <div class="deck-options">
                                <button onclick="selectedDecks = 1; showLobby(onlineRoomId)">1</button>
                                <button onclick="selectedDecks = 2; showLobby(onlineRoomId)">2</button>
                                <button onclick="selectedDecks = 5; showLobby(onlineRoomId)">5</button>
                                <button onclick="selectedDecks = 8; showLobby(onlineRoomId)">8</button>
                                <button onclick="selectedDecks = 12; showLobby(onlineRoomId)">12</button>
                            </div>
                            <p>المحدد: <strong>${selectedDecks}</strong> رزمة</p>
                        </div>
                    ` : `
                        <div class="waiting-room-info">
                            <span>عدد الرزمات</span>
                            <strong>${selectedDecks}</strong>
                        </div>
                    `}

                    <div class="waiting-room-actions">
                        ${isHost
                          ? `<button class="hero-play-btn" onclick="startManualGame()">بدء المباراة</button>`
                          : `<button class="hero-play-btn" disabled>انتظار بدء اللعبة</button>`}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function startManualGame() {
    console.log("بدء المباراة، الغرفة:", onlineRoomId, "عدد اللاعبين:", onlineRoomPlayers.length);

    if (!onlineRoomId) {
        console.error("❌ الغرفة فارغة!");
        showMessage("خطأ: الغرفة غير محددة");
        return;
    }

    // إضافة كمبيوتر تلقائياً للمقاعد الفارغة
    const currentPlayers = onlineRoomPlayers.length || 1;
    const computersToAdd = Math.max(0, 4 - currentPlayers);
    
    console.log(`سيتم إضافة ${computersToAdd} كمبيوتر تلقائياً`);

    socket.emit("startManualRoom", {
        roomId: onlineRoomId,
        decks: selectedDecks,
        computersToAdd: computersToAdd
    });

    console.log("✅ تم إرسال الحدث startManualRoom");
}
function addComputerToRoom() {
    console.log("ضغط إضافة كمبيوتر", onlineRoomId);

    if (!onlineRoomId) {
        showMessage("لا يوجد رمز غرفة");
        return;
    }

    socket.emit("addComputer", onlineRoomId);
}
function addComputer() {
    socket.emit("addComputer", currentRoomId);
}

function selectSeat(seatIndex) {
    console.log(`محاولة اختيار المقعد ${seatIndex + 1}`);
    
    if (!onlineRoomId) {
        showMessage("لا توجد غرفة محددة");
        return;
    }
    
    socket.emit("selectSeat", {
        roomId: onlineRoomId,
        seatIndex: seatIndex
    });
}



function createDeck(numberOfDecks = 5) {
    const suits = ["♥", "♦", "♠", "♣"];
    const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    let deck = [];

    for (let d = 0; d < numberOfDecks; d++) {
        for (let suit of suits) {
            for (let rank of ranks) {
                deck.push({ rank, suit, text: rank + suit });
            }
        }

        deck.push({ rank: "JOKER", suit: "", text: "🃏" });
        deck.push({ rank: "JOKER", suit: "", text: "🃏" });
    }

    return shuffle(deck);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getSeatNamesForGame() {
    if (onlineRoomId && Array.isArray(onlineRoomPlayers) && onlineRoomPlayers.length > 0) {
        return Array.from({ length: 4 }, (_, index) => {
            const player = onlineRoomPlayers[index];
            return player && player.username ? player.username : `كمبيوتر ${index + 1}`;
        });
    }

    return [
        "سامي",
        "كمبيوتر 1",
        "كمبيوتر 2",
        "كمبيوتر 3"
    ];
}

function dealCards() {
    const deck = createDeck(selectedDecks);

    console.log("عدد أوراق الرزمة:", deck.length);

    const players = getSeatNamesForGame().map((name) => ({
        name,
        hand: [],
        stack: []
    }));

    const field = [];
    const neededRanks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

    for (let rank of neededRanks) {
        const index = deck.findIndex(card => card.rank === rank);
        if (index !== -1) {
            field.push(deck.splice(index, 1)[0]);
        }
    }

    for (let i = 0; i < 7; i++) {
        for (let player of players) {
            player.hand.push(deck.pop());
        }
    }

    players[0].hand.push(deck.pop());

    return { deck, players, field };
}



function getCardImage(card) {
    if (!card) return "";

    if (card.rank === "JOKER" || card.text === "🃏") {
        return "SVG-cards-1.3/black_joker.svg";
    }

    const suitMap = {
        "♠": "spades",
        "♥": "hearts",
        "♦": "diamonds",
        "♣": "clubs"
    };

    const rankMap = {
        "A": "ace",
        "K": "king",
        "Q": "queen",
        "J": "jack"
    };

    const rank = rankMap[card.rank] || card.rank;
    const suit = suitMap[card.suit];

    const use2 = ["K", "Q", "J"].includes(card.rank);

    return `SVG-cards-1.3/${rank}_of_${suit}${use2 ? "2" : ""}.svg`;
}

function curveCards() {
    const cards = document.querySelectorAll(".cards .card");
    const count = cards.length;
    const middle = (count - 1) / 2;

    const isMobile = window.innerWidth <= 768;
    const spread = isMobile ? 31 : 35;
    const baseY = isMobile ? 18 : 0;
    const maxRotate = isMobile ? 8 : 8;

    const container = document.querySelector(".cards");
    const center = container ? container.offsetWidth / 2 : window.innerWidth / 2;

    cards.forEach((card, i) => {
        const offset = i - middle;
        const rotate = middle === 0 ? 0 : offset * (maxRotate / middle);
        const y = baseY + Math.abs(offset) * 2;

        card.style.position = "absolute";
        card.style.left = `${center + offset * spread}px`;
        card.style.bottom = "0px";
        card.style.transform =
            `translateX(-50%) translateY(${y}px) rotate(${rotate}deg)`;

        card.style.zIndex = i + 1;
    });
}

function renderCard(card, index = null) {
    let colorClass = getColorClass(card);

    let canObject = false;

    if (objectionTimer && objectionRank) {
        canObject = card.rank === objectionRank || card.rank === "JOKER";
    }

    const objectClass = canObject ? "can-object" : "";

    return `
        <div class="card ${colorClass} ${objectClass}"
                data-rank="${card.rank}"
                data-index="${index}"
                onclick="selectCard(this, '${card.rank}', ${index})">

            ${canObject ? '<span class="object-badge">اعتراض</span>' : ''}

            <img class="card-image"
                 src="${getCardImage(card)}"
                 draggable="false">

        </div>
    `;
}

function renderFieldCard(card, index) {
    let colorClass = getColorClass(card);

    return `
        <div class="card ${colorClass}" onclick="fieldClick('${card.rank}', ${index})">
            <img class="card-image"
                 src="${getCardImage(card)}"
                 draggable="false">
        </div>
    `;
}

function getColorClass(card) {
    if (card.rank === "JOKER") return "joker";
    if (card.suit === "♥" || card.suit === "♦") return "red";
    return "black";
}

function getOnlinePlayerName(index) {
    const gamePlayer = gameState && gameState.players && gameState.players[index];
    if (gamePlayer && gamePlayer.name) return gamePlayer.name;

    const player = onlineRoomPlayers[index];
    if (player && player.username) return player.username;

    const defaults = ["أنت", "كمبيوتر 1", "كمبيوتر 2", "كمبيوتر 3"];
    return defaults[index] || `لاعب ${index + 1}`;
}

function getOnlinePlayerDisplay(index, suffix = "") {
    const name = getOnlinePlayerName(index);
    return `${name}${suffix}`;
}

function startGame(receivedState = null) {

    if (receivedState) {
        gameState = receivedState;
    } else {
        gameState = dealCards();
        gameState.currentPlayer = 0;
    }

    currentPlayer = gameState.currentPlayer || 0;
    recordGameStart();

    saveGame();
    renderGame();

    //runBotIfNeeded();

    if (onlineRoomId && !receivedState && myOnlineIndex === 0) {
        console.log("ارسلت توزيع اللعبة");

        socket.emit("sendGameState", {
            roomId: onlineRoomId,
            gameState
        });
    }
}

function runBotIfNeeded() {
    if (!onlineRoomId) return;
    if (myOnlineIndex !== 0) return;
    if (botThinking) return;

    const player = onlineRoomPlayers[currentPlayer];

    if (!player || !player.isBot) return;

    botThinking = true;

    setTimeout(() => {
        computerTurn();

        botThinking = false;

        saveGame();
        renderGame();
        syncOnlineGame();
    }, 1000);
}

function sortHand(hand) {

    const rankOrder = {
        "A": 1,
        "2": 2,
        "3": 3,
        "4": 4,
        "5": 5,
        "6": 6,
        "7": 7,
        "8": 8,
        "9": 9,
        "10": 10,
        "J": 11,
        "Q": 12,
        "K": 13,
        "JOKER": 0
    };

    hand.sort((a, b) => {

        if (a.rank === "JOKER" && b.rank !== "JOKER") return -1;
        if (b.rank === "JOKER" && a.rank !== "JOKER") return 1;

        return rankOrder[a.rank] - rankOrder[b.rank];
    });
}

function renderBackCards(playerIndex, horizontal = false) {
    const count = gameState.players[playerIndex].hand.length;

    return `
        <div class="${horizontal ? "top-back-cards" : "side-back-cards"}">
            ${Array.from({ length: count }).map(() => `
                <div class="back-card"></div>
            `).join("")}
        </div>
    `;
}

function renderGame() {
    if (roundEnded) return;

    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    const bottomIndex = localPlayerIndex;
    const leftIndex = (localPlayerIndex + 1) % 4;
    const topIndex = (localPlayerIndex + 2) % 4;
    const rightIndex = (localPlayerIndex + 3) % 4;

    const myCardsHtml = gameState.players[bottomIndex].hand
        .map((card, index) => renderCard(card, index))
        .join("");

    const fieldHtml = gameState.field
        .map((card, index) => renderFieldCard(card, index))
        .join("");

    const myTopStack =
        pendingCapture && pendingCapture.owner === bottomIndex
            ? renderSimpleCard(pendingCapture.cards[pendingCapture.cards.length - 1])
            : gameState.players[bottomIndex].stack.length > 0
                ? renderSimpleCard(
                    gameState.players[bottomIndex].stack[
                        gameState.players[bottomIndex].stack.length - 1
                    ]
                )
                : "؟";

    const myName = currentUser?.name || "أنت";

    document.body.innerHTML = `
        <div id="game-container">

            <button class="mobile-panel-toggle" onclick="toggleMobilePanel()" aria-label="القائمة">☰</button>


            <button class="mobile-exit-btn" onclick="exitGame()">خروج</button>
            
            <div class="mobile-panel-overlay" id="mobile-panel-overlay" onclick="toggleMobilePanel()"></div>

            <div class="mobile-score-panel">
                <table>
                    <tr>
                        <th>فريقك</th>
                        <th>الخصوم</th>
                    </tr>
                    <tr>
                        <td>${getMyTeamPoints()}</td>
                        <td>${getEnemyTeamPoints()}</td>
                    </tr>
                </table>
            </div>

            <div class="left-panel">
                <div class="player-profile-card">
                    <div class="player-profile-top">
                        <div>
                            <p class="profile-label">الغرفة</p>
                            <h3>${onlineRoomId || "فردية"}</h3>
                        </div>
                    </div>

                    <div class="stats-grid">
                        <div class="stat-pill">
                            <span>اللاعبون</span>
                            <strong>${onlineRoomPlayers.filter(p => !p.isBot).length || 1}/4</strong>
                        </div>

                        <div class="stat-pill">
                            <span>موقعك</span>
                            <strong>#${myOnlineIndex + 1}</strong>
                        </div>
                    </div>
                </div>

                <div class="side-panel">
                    <button class="panel-btn" onclick="exitGame()">خروج</button>
                    <button class="panel-btn" onclick="showHelpModal()">مساعدة</button>
                    <button class="panel-btn" onclick="shareGame()">مشاركة</button>
                    <button class="panel-btn" onclick="toggleSound()">الصوت</button>
                </div>

                <div class="score-panel">
                    <table>
                        <tr>
                            <th>فريقك</th>
                            <th>الخصوم</th>
                        </tr>
                        <tr>
                            <td>${getMyTeamPoints()}</td>
                            <td>${getEnemyTeamPoints()}</td>
                        </tr>
                    </table>
                </div>

                <div class="chat-section">
                    <div class="chat-header">💬 الدردشة</div>

                    <div class="chat-messages" id="chat-messages"></div>

                    <div class="chat-input-row">
                        <input
                            id="chat-input"
                            type="text"
                            placeholder="اكتب رسالة..."
                            maxlength="200"
                            onkeydown="if(event.key==='Enter') sendChatMessage()"
                            autocomplete="off"
                        >

                        <button onclick="sendChatMessage()" class="chat-send-btn">إرسال</button>
                    </div>
                </div>
            </div>

            <div class="game-table">
                <div id="game-message"></div>
                <div id="objection-box">&nbsp;</div>

                <div class="top-player">
                    <div class="player-card ${currentPlayer === topIndex ? 'active-player' : ''}">
                        <img class="player-avatar" src="images/default-avatar.png">

                        <div class="player-name">
                            ${getOnlinePlayerName(topIndex)}
                            ${objectionPlayer === topIndex ? "⚠️" : ""}
                        </div>
                    </div>

                    ${renderBackCards(topIndex, true)}

                    <div class="top-stack-row" onclick="takeFromStack(${topIndex})">
                        ${getTopStackHtml(topIndex)}
                    </div>
                </div>

                <div class="middle-row">
                    <div class="side-player left-side">
                        <div class="player-card ${currentPlayer === leftIndex ? 'active-player' : ''}">
                            <img class="player-avatar" src="images/default-avatar.png">

                            <div class="player-name">
                                ${getOnlinePlayerName(leftIndex)}
                                ${objectionPlayer === leftIndex ? "⚠️" : ""}
                            </div>
                        </div>

                        ${renderBackCards(leftIndex)}

                        <div class="stack" onclick="takeFromStack(${leftIndex})">
                            ${getTopStackHtml(leftIndex)}
                        </div>
                    </div>

                    <div class="field">
                        <h3>الميدان</h3>

                        <div class="field-cards">
                            ${fieldHtml}
                        </div>
                    </div>

                    <div class="side-player right-side">
                        <div class="player-card ${currentPlayer === rightIndex ? 'active-player' : ''}">
                            <img class="player-avatar" src="images/default-avatar.png">

                            <div class="player-name">
                                ${getOnlinePlayerName(rightIndex)}
                                ${objectionPlayer === rightIndex ? "⚠️" : ""}
                            </div>
                        </div>

                        ${renderBackCards(rightIndex)}

                        <div class="stack" onclick="takeFromStack(${rightIndex})">
                            ${getTopStackHtml(rightIndex)}
                        </div>
                    </div>
                </div>

                <div class="my-stack">
                    <h3>
                        تجميع ${myName}
                        ${objectionPlayer === bottomIndex ? "⚠️" : ""}
                    </h3>

                    <div class="stack">
                        ${myTopStack}
                    </div>
                </div>

                ${canHumanObject()
                    ? `<button class="objection-btn" onclick="objectNow()">اعتراض (${objectionSeconds})</button>`
                    : ""}

                <div class="cards-wrapper">
                    <div class="cards">
                        ${myCardsHtml}
                    </div>
                </div>

                <div class="my-cards">
                    <div class="bottom-profile">
                        <div class="bottom-name">
                            ${myName}
                            ${objectionPlayer === bottomIndex ? "⚠️" : ""}
                        </div>

                        <img
                            class="bottom-avatar ${currentPlayer === bottomIndex ? 'active-avatar' : ''}"
                            src="images/default-avatar.png"
                        >
                    </div>

                    <div class="action-buttons">
                        <button onclick="drawCard()">سحب</button>
                        <button onclick="dropCard()">تنزيل</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    curveCards();
    enableDragSelect();

    chatMessages.forEach(msg => appendChatMessage(msg, true));

    setTimeout(() => {
        if (
            onlineRoomId &&
            myOnlineIndex === 0 &&
            onlineRoomPlayers[currentPlayer]?.isBot &&
            !pendingCapture
        ) {
            computerTurn();
        }
    }, 800);
}

function enableSwipeSelect() {
    const cards = document.querySelectorAll(".cards .card");

    cards.forEach(card => {
        let startX = 0;
        let dragging = false;

        card.onmousedown = (e) => {
            startX = e.clientX;
            dragging = true;
        };

        card.onmousemove = (e) => {
            if (!dragging) return;

            const diff = e.clientX - startX;

            if (Math.abs(diff) > 30) {
                card.click(); // يحدد الورقة
                dragging = false;
            }
        };

        card.onmouseup = () => {
            dragging = false;
        };

        card.onmouseleave = () => {
            dragging = false;
        };
    });
}

function renderSimpleCard(card) {
    return `
        <img
            class="simple-card-image horizontal-stack-card"
            src="${getCardImage(card)}"
            draggable="false"
        >
    `;
}

function selectCard(cardElement, rank, index) {
    selectedCard = cardElement;
    selectedCardData = rank;
    selectedCardIndex = index;

    document.querySelectorAll(".cards .card").forEach(card => {
        card.classList.remove("selected");
    });

    cardElement.classList.add("selected");
}

function enableDragSelect() {
    let mouseDown = false;

    document.addEventListener("mousedown", () => {
        mouseDown = true;
    });

    document.addEventListener("mouseup", () => {
        mouseDown = false;
    });

    document.querySelectorAll(".cards .card").forEach(card => {
        card.addEventListener("mouseenter", () => {
            if (!mouseDown) return;
            

            const rank = card.getAttribute("data-rank");
            const index = Number(card.getAttribute("data-index"));

            selectCard(card, rank, index);
        });
    });
}

function fieldClick(rank, fieldIndex) {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    if (currentPlayer !== localPlayerIndex) {
        showMessage("ليس دورك الآن");
        return;
    }

    if (selectedCardData === null || selectedCardIndex === null) {
        showMessage("اختر ورقة من يدك أولاً");
        return;
    }

    if (selectedCardData !== rank && selectedCardData !== "JOKER") {
        showMessage("لا يمكنك أخذ هذه الورقة");
        return;
    }

    const handCard = gameState.players[localPlayerIndex].hand.splice(selectedCardIndex, 1)[0];
    const fieldCard = gameState.field.splice(fieldIndex, 1)[0];

    pendingCapture = {
        owner: localPlayerIndex,
        cards: [fieldCard, handCard],
        visibleRank: handCard.rank === "JOKER" ? fieldCard.rank : handCard.rank
    };

    objectionRank = pendingCapture.visibleRank;
    objectionOwner = localPlayerIndex;
    objectionPlayer = localPlayerIndex;

    selectedCard = null;
    selectedCardData = null;
    selectedCardIndex = null;

    playSound("capture");
    saveGame();
    renderGame();
    syncOnlineGame();
    startObjection();
}
function drawCard() {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    if (objectionTimer) {
    showMessage("لا يمكنك السحب أثناء وقت الاعتراض");
    return;
    }
    if (currentPlayer !== localPlayerIndex) {
    showMessage("ليس دورك حالياً");
    return;
    }
    const myHand = gameState.players[localPlayerIndex].hand;

    if (myHand.length >= 8) {
        showMessage("لا يمكنك السحب، لديك 8 أوراق");
        return;
    }

    if (gameState.deck.length === 0) {
        showMessage("انتهت الرزمة");
        return;
    }

    myHand.push(gameState.deck.pop());

    playSound("draw");

    selectedCard = null;
    selectedCardData = null;
    selectedCardIndex = null;

    saveGame();
    renderGame();
    syncOnlineGame();
}
function dropCard() {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    if (objectionTimer) {
        showMessage("لا يمكنك التنزيل أثناء وقت الاعتراض");
        return;
    }

    if (currentPlayer !== localPlayerIndex) {
        showMessage("ليس دورك حالياً");
        return;
    }

    if (selectedCardIndex === null) {
        showMessage("اختر ورقة أولاً");
        return;
    }

    const myHand = gameState.players[localPlayerIndex].hand;
    const handCard = myHand[selectedCardIndex];
    const isLastCard = myHand.length === 1;
    const deckIsEmpty = !gameState.deck || gameState.deck.length === 0;

    // القاعدة الأصلية: ممنوع تنزيل رتبة موجودة في الميدان.
    // لكن عند نهاية اللعب، إذا كانت هذه آخر ورقة والرزمة انتهت، نسمح بتنزيلها حتى لا تتعلق الجولة.
    const exists = gameState.field.some(card => card.rank === handCard.rank);

    if (exists && !(isLastCard && deckIsEmpty)) {
        showMessage("لا يجوز تنزيل ذات موجودة في الميدان");
        return;
    }

    gameState.field.push(myHand.splice(selectedCardIndex, 1)[0]);

    playSound("card");

    selectedCard = null;
    selectedCardData = null;
    selectedCardIndex = null;

    nextTurn();
    syncOnlineGame();
}
function isRoundFinished() {

    if (gameState.deck.length > 0) {
        return false;
    }

    return gameState.players.every(player =>
        player.hand.length === 0
    );
}
function nextTurn() {
    if (roundEnded) return;
    if (isRoundFinished()) {
        endRound();
        return;
    }

    let tries = 0;

    do {
        currentPlayer = (currentPlayer + 1) % 4;
        tries++;
    } while (
        tries < 4 &&
        gameState.deck.length === 0 &&
        gameState.players[currentPlayer].hand.length === 0
    );

    if (isRoundFinished()) {
        endRound();
        return;
    }

    saveGame();
    renderGame();
    syncOnlineGame();

    if (!onlineRoomId && currentPlayer !== 0) {
        setTimeout(computerTurn, 1000);
    }
}


function computerTurn() {
    if (roundEnded) return;
    const player = gameState.players[currentPlayer];

    if (player.hand.length < 8 && gameState.deck.length > 0) {
        player.hand.push(gameState.deck.pop());
    }

    const chances = [];

    for (let i = 0; i < player.hand.length; i++) {
        const handCard = player.hand[i];

        for (let f = 0; f < gameState.field.length; f++) {
            const fieldCard = gameState.field[f];

            if (handCard.rank === fieldCard.rank || handCard.rank === "JOKER") {
                chances.push({ handIndex: i, fieldIndex: f });
            }
        }
    }

    if (chances.length > 0 && Math.random() < 0.7) {
        const chance = chances[Math.floor(Math.random() * chances.length)];

        const usedCard = player.hand.splice(chance.handIndex, 1)[0];
        const fieldCard = gameState.field.splice(chance.fieldIndex, 1)[0];

        pendingCapture = {
            owner: currentPlayer,
            cards: [fieldCard, usedCard],
            visibleRank: usedCard.rank === "JOKER" ? fieldCard.rank : usedCard.rank
        };

        objectionRank = pendingCapture.visibleRank;
        objectionOwner = currentPlayer;
        objectionPlayer = currentPlayer;

        saveGame();
        renderGame();
        startObjection();
        syncOnlineGame();
        return;
    }

    const dropIndex = player.hand.findIndex(handCard =>
        handCard.rank !== "JOKER" &&
        !gameState.field.some(fieldCard => fieldCard.rank === handCard.rank)
    );

    if (dropIndex !== -1) {
        gameState.field.push(player.hand.splice(dropIndex, 1)[0]);
        nextTurn();
        syncOnlineGame();
        return;
    }

    const jokerIndex = player.hand.findIndex(card => card.rank === "JOKER");

    if (jokerIndex !== -1 && gameState.field.length > 0) {
        const usedCard = player.hand.splice(jokerIndex, 1)[0];
        const fieldCard = gameState.field.splice(0, 1)[0];

        pendingCapture = {
            owner: currentPlayer,
            cards: [fieldCard, usedCard],
            visibleRank: fieldCard.rank
        };

        objectionRank = pendingCapture.visibleRank;
        objectionOwner = currentPlayer;
        objectionPlayer = currentPlayer;

        saveGame();
        renderGame();
        startObjection();
        syncOnlineGame();
        return;
    }

    nextTurn();
    syncOnlineGame();
}
function getTopStackHtml(playerIndex) {

    if (pendingCapture && pendingCapture.owner === playerIndex) {

        let visibleCard = pendingCapture.cards[pendingCapture.cards.length - 1];

        if (visibleCard.rank === "JOKER") {
            for (let i = pendingCapture.cards.length - 2; i >= 0; i--) {
                if (pendingCapture.cards[i].rank !== "JOKER") {
                    visibleCard = pendingCapture.cards[i];
                    break;
                }
            }
        }

        return renderSimpleCard(visibleCard);
    }

    const stack = gameState.players[playerIndex].stack;

    if (stack.length === 0) return "";

    let visibleCard = stack[stack.length - 1];

    if (visibleCard.rank === "JOKER") {
        for (let i = stack.length - 2; i >= 0; i--) {
            if (stack[i].rank !== "JOKER") {
                visibleCard = stack[i];
                break;
            }
        }
    }

    return renderSimpleCard(visibleCard);
}
function takeFromStack(targetPlayerIndex) {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    if (currentPlayer !== localPlayerIndex) {
        showMessage("ليس دورك حالياً");
        return;
    }

    if (selectedCardIndex === null) {
        showMessage("اختر ورقة من يدك أولاً");
        return;
    }

    const myPlayer = gameState.players[localPlayerIndex];
    const targetPlayer = gameState.players[targetPlayerIndex];

    if (targetPlayer.stack.length === 0) {
        showMessage("تجميع هذا اللاعب فارغ");
        return;
    }

    const handCard = myPlayer.hand[selectedCardIndex];
    const topCard = targetPlayer.stack[targetPlayer.stack.length - 1];

    if (handCard.rank !== topCard.rank && handCard.rank !== "JOKER") {
        showMessage("لا يمكنك أخذ هذا التجميع");
        return;
    }

    const takenCards = [];
    const targetRank = topCard.rank;

    while (
        targetPlayer.stack.length > 0 &&
        targetPlayer.stack[targetPlayer.stack.length - 1].rank === targetRank
    ) {
        takenCards.push(targetPlayer.stack.pop());
    }

    const usedCard = myPlayer.hand.splice(selectedCardIndex, 1)[0];

    if (usedCard.rank === "JOKER") {
        // الجوكر لا يكون ظاهر، الورقة المأخوذة تبقى هي الظاهرة
        const visibleCard = takenCards[0];
        const restCards = takenCards.slice(1).reverse();

        myPlayer.stack.push(...restCards);
        myPlayer.stack.push(usedCard);
        myPlayer.stack.push(visibleCard);
    } else {
        // الورقة التي لعبتها من يدك تكون الظاهرة
        myPlayer.stack.push(...takenCards.reverse());
        myPlayer.stack.push(usedCard);
    }

    selectedCard = null;
    selectedCardData = null;
    selectedCardIndex = null;

    objectionRank = gameState.players[localPlayerIndex].stack[gameState.players[localPlayerIndex].stack.length - 1].rank;
    objectionOwner = localPlayerIndex;

    pendingStack = true;

    playSound("capture");
    saveGame();
    renderGame();
    syncOnlineGame();

    startObjection();
}
function startObjection(shouldSync = true) {
    if (roundEnded) return;
    objectionSeconds = 5;
    playSound("objection");

    clearInterval(objectionTimer);

    objectionTimer = setInterval(() => {
        objectionSeconds--;

        updateObjection();

        checkComputerObjections();

        if (objectionSeconds <= 0) {
            clearInterval(objectionTimer);
            objectionTimer = null;

            if (pendingCapture) {
                gameState.players[pendingCapture.owner].stack.push(
                    ...pendingCapture.cards
                );

                currentPlayer = pendingCapture.owner;

                pendingCapture = null;
                objectionPlayer = null;
            }

            pendingStack = null;
            objectionRank = null;
            objectionOwner = null;

            const box = document.getElementById("objection-box");
            if (box) {
                box.innerHTML = "&nbsp;";
            }

            saveGame();
            renderGame();

            if (shouldSync) {
                syncOnlineGame();
            }

            if (
                   gameState.deck.length === 0 &&
                   gameState.players[currentPlayer].hand.length === 0
                    ) {
                    nextTurn();
                    return;
                     }
        }
    }, 1000);

    updateObjection();
    renderGame();

    if (shouldSync) {
        syncOnlineGame();
    }
}

function updateObjection() {

    const box = document.getElementById("objection-box");

    if (!box) return;

    box.innerHTML = `⏳ اعتراض: ${objectionSeconds}`;
}
function checkComputerObjections() {
    if (!objectionTimer || !objectionRank || !pendingCapture) {
        return;
    }

    // في الأونلاين: الهوست فقط يشغل اعتراضات الكمبيوتر حتى لا تتكرر من أكثر من جهاز
    if (onlineRoomId && myOnlineIndex !== 0) {
        return;
    }

    for (let i = 0; i < gameState.players.length; i++) {
        if (i === pendingCapture.owner) continue;

        // في الأونلاين لا نجعل اللاعبين الحقيقيين يعترضون تلقائياً، فقط الكمبيوتر
        if (onlineRoomId && !onlineRoomPlayers[i]?.isBot) continue;

        // في المحلي اللاعب رقم 0 هو المستخدم، فلا يعترض تلقائياً
        if (!onlineRoomId && i === 0) continue;

        const player = gameState.players[i];

        const sameRankIndex = player.hand.findIndex(card => card.rank === objectionRank);
        const jokerIndex = player.hand.findIndex(card => card.rank === "JOKER");

        let cardIndex = -1;

        if (sameRankIndex !== -1 && Math.random() < 0.5) {
            cardIndex = sameRankIndex;
        } else if (jokerIndex !== -1 && Math.random() < 0.2) {
            cardIndex = jokerIndex;
        }

        if (cardIndex === -1) continue;

        const usedCard = player.hand.splice(cardIndex, 1)[0];

        if (usedCard.rank === "JOKER") {
            const visibleCard = pendingCapture.cards[pendingCapture.cards.length - 1];
            const restCards = pendingCapture.cards.slice(0, -1);

            pendingCapture = {
                owner: i,
                cards: [...restCards, usedCard, visibleCard],
                visibleRank: visibleCard.rank
            };
        } else {
            pendingCapture = {
                owner: i,
                cards: [...pendingCapture.cards, usedCard],
                visibleRank: usedCard.rank
            };
        }

        objectionOwner = i;
        objectionPlayer = i;
        objectionRank = pendingCapture.visibleRank;

        showMessage(player.name + " اعترض!");

        clearInterval(objectionTimer);
        objectionTimer = null;

        
        saveGame();
        renderGame();
        startObjection();

        if (onlineRoomId) {
            syncOnlineGame();
        }

        return;
    }
}
function objectNow() {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    if (!objectionTimer || !objectionRank || !pendingCapture) return;

    const myPlayer = gameState.players[localPlayerIndex];

    let cardIndex = myPlayer.hand.findIndex(card => card.rank === objectionRank);

    if (cardIndex === -1) {
        cardIndex = myPlayer.hand.findIndex(card => card.rank === "JOKER");
    }

    if (cardIndex === -1) {
        showMessage("لا تملك ورقة اعتراض");
        return;
    }

    const usedCard = myPlayer.hand.splice(cardIndex, 1)[0];
    recordObjectionUse();

    if (usedCard.rank === "JOKER") {
        const visibleCard = pendingCapture.cards[pendingCapture.cards.length - 1];
        const restCards = pendingCapture.cards.slice(0, -1);

        pendingCapture = {
            owner: localPlayerIndex,
            cards: [...restCards, usedCard, visibleCard],
            visibleRank: visibleCard.rank
        };
    } else {
        pendingCapture = {
            owner: localPlayerIndex,
            cards: [...pendingCapture.cards, usedCard],
            visibleRank: usedCard.rank
        };
    }

    objectionOwner = localPlayerIndex;
    objectionPlayer = localPlayerIndex;
    objectionRank = pendingCapture.visibleRank;

    selectedCard = null;
    selectedCardData = null;
    selectedCardIndex = null;

    clearInterval(objectionTimer);
    objectionTimer = null;

    
    saveGame();
    renderGame();
    
    startObjection();

    syncOnlineGame();

    playSound("objection");
    showMessage("اعترضت");
}
function showMessage(text, duration = 2000) {
    const box = document.getElementById("game-message");

    if (!box) return;

    box.textContent = text;
    box.classList.add("show");

    clearTimeout(box.timeout);

    box.timeout = setTimeout(() => {
        box.classList.remove("show");
    }, duration);
}
function canHumanObject() {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;

    if (!gameState || !gameState.players || !gameState.players[localPlayerIndex]) {
        return false;
    }

    if (!pendingCapture || !objectionRank || objectionSeconds <= 0) {
        return false;
    }

    if (pendingCapture.owner === localPlayerIndex) {
        return false;
    }

    const myHand = gameState.players[localPlayerIndex].hand || [];

    return myHand.some(card =>
        card.rank === objectionRank || card.rank === "JOKER"
    );
}
function getCardPoints(card) {
    if (card.rank === "JOKER") return 30;

    if (
        card.rank === "A" ||
        card.rank === "10" ||
        card.rank === "J" ||
        card.rank === "Q" ||
        card.rank === "K"
    ) {
        return 10;
    }

    return 0;
}

function calculateTeamPoints(teamPlayers) {
    let total = 0;

    for (let playerIndex of teamPlayers) {
        const player = gameState.players[playerIndex];

        for (let card of player.stack) {
            total += getCardPoints(card);
        }
    }

    return total;
}

function getMyTeamPoints() {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;
    
    // تحديد فريقك بناءً على موقعك
    let myTeamIndices;
    if (localPlayerIndex === 0 || localPlayerIndex === 2) {
        myTeamIndices = [0, 2];
    } else {
        myTeamIndices = [1, 3];
    }
    
    return calculateTeamPoints(myTeamIndices);
}

function getEnemyTeamPoints() {
    const localPlayerIndex = onlineRoomId ? myOnlineIndex : 0;
    
    // تحديد فريق الخصوم بناءً على موقعك
    let enemyTeamIndices;
    if (localPlayerIndex === 0 || localPlayerIndex === 2) {
        enemyTeamIndices = [1, 3];
    } else {
        enemyTeamIndices = [0, 2];
    }
    
    return calculateTeamPoints(enemyTeamIndices);
}

function endRound() {
    if (roundEnded) return;
    playSound("win");
    roundEnded = true;

    clearInterval(objectionTimer);
    objectionTimer = null;

    const myPoints = calculateTeamPoints([0, 2]);
    const enemyPoints = calculateTeamPoints([1, 3]);

    let result = "";
    let resultClass = "draw";
    let resultIcon = "⚖️";

    if (myPoints > enemyPoints) {
        result = "فريقك فاز 🏆";
        resultClass = "win";
        resultIcon = "🏆";
    } else if (enemyPoints > myPoints) {
        result = "الخصوم فازوا 🏆";
        resultClass = "lose";
        resultIcon = "😞";
    } else {
        result = "تعادل";
        resultClass = "draw";
        resultIcon = "🤝";
    }

    // إرسال النتائج للخادم
    const winner = myPoints > enemyPoints ? "فريقك" : (enemyPoints > myPoints ? "الخصوم" : "");
    const playersResults = gameState.players.map((p, index) => ({
        username: p.name || `لاعب ${index + 1}`,
        points: index === 0 || index === 2 ? myPoints : enemyPoints,
        isWinner: (winner === "فريقك" && (index === 0 || index === 2)) ||
                  (winner === "الخصوم" && (index === 1 || index === 3))
    }));

    // إرسال نتائج اللاعبين الحقيقيين فقط
    const realPlayers = playersResults.filter(p => !p.username.includes("كمبيوتر"));
    if (realPlayers.length > 0) {
        socket.emit("gameEnded", {
            winner: realPlayers.find(p => p.isWinner)?.username,
            players: realPlayers
        });
    }

    document.body.innerHTML = `
        <div class="result-screen">
            <div class="result-card ${resultClass}">
                <div class="result-icon">${resultIcon}</div>
                <h1>انتهت الجولة</h1>
                <h2>${result}</h2>

                <div class="result-score">
                    <div>
                        <span>فريقك</span>
                        <strong>${myPoints}</strong>
                    </div>
                    <div>
                        <span>الخصوم</span>
                        <strong>${enemyPoints}</strong>
                    </div>
                </div>

                <div class="result-actions">
                    <button onclick="startGame()">جولة جديدة</button>
                    <button onclick="location.reload()">رجوع</button>
                </div>
            </div>
        </div>
    `;
}
function showRealPlayers() {
    if (!currentUser) {
        showLoginPage();
        return;
    }

    document.body.innerHTML = `
        <div class="main-menu-screen">
            <div class="main-menu-shell">
                <header class="main-menu-header">
                    <div>
                        <p class="menu-badge">مجابيد</p>
                        <h2>لاعبون حقيقيون</h2>
                    </div>
                    <button class="menu-icon-btn" onclick="showMainMenu()">رجوع</button>
                </header>

                <section class="menu-grid" style="grid-template-columns:1fr;">
                    <button class="hero-play-btn" onclick="showCreateSession()" style="margin-bottom:8px;">
                        ➕ إنشاء جلسة جديدة
                    </button>
                </section>

                <section>
                    <h3 style="margin:16px 0 8px;font-size:1rem;opacity:.7;">الجلسات المتاحة</h3>
                    <div id="public-rooms-list">
                        <p style="opacity:.5;text-align:center;padding:24px;">جارٍ البحث...</p>
                    </div>
                </section>
            </div>
        </div>
    `;

    socket.emit("getPublicRooms");
}

function showCreateSession() {
    if (!currentUser) {
        showLoginPage();
        return;
    }

    document.body.innerHTML = `
        <div class="main-menu-screen">
            <div class="main-menu-shell">
                <header class="main-menu-header">
                    <div>
                        <p class="menu-badge">مجابيد</p>
                        <h2>إنشاء جلسة</h2>
                    </div>
                    <button class="menu-icon-btn" onclick="showRealPlayers()">رجوع</button>
                </header>

                <div class="room-card" style="margin-top:16px;">
                    <form onsubmit="event.preventDefault(); submitCreateSession();">
                        <div style="margin-bottom:12px;">
                            <label style="display:block;margin-bottom:4px;font-size:.9rem;">عنوان الجلسة</label>
                            <input id="sessionTitle" type="text" placeholder="مثال: جلسة ليلية مكة" maxlength="60"
                                style="width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#1e2230;color:#fff;box-sizing:border-box;">
                        </div>
                        <div style="margin-bottom:12px;">
                            <label style="display:block;margin-bottom:4px;font-size:.9rem;">الموقع (اختياري)</label>
                            <input id="sessionLocation" type="text" placeholder="مثال: جدة - حي الروضة" maxlength="60"
                                style="width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#1e2230;color:#fff;box-sizing:border-box;">
                        </div>
                        <button type="submit" class="hero-play-btn" style="width:100%;margin-top:8px;">
                            إنشاء الجلسة
                        </button>
                    </form>
                    <p id="createSessionError" style="color:#e05;margin-top:8px;display:none;"></p>
                </div>
            </div>
        </div>
    `;
}

function submitCreateSession() {
    console.log("🔥 submitCreateSession called");
    
    const title = document.getElementById("sessionTitle")?.value.trim();
    const location = document.getElementById("sessionLocation")?.value.trim();
    const errorEl = document.getElementById("createSessionError");
    const submitBtn = document.querySelector("button[type='submit']");

    console.log("📝 Title:", title, "Location:", location, "currentUser:", currentUser);

    if (!title) {
        console.warn("⚠️ No title provided");
        if (errorEl) { errorEl.textContent = "أدخل عنوان الجلسة"; errorEl.style.display = "block"; }
        return;
    }

    if (!currentUser) {
        console.warn("⚠️ Not logged in");
        if (errorEl) { errorEl.textContent = "يجب تسجيل الدخول أولاً"; errorEl.style.display = "block"; }
        return;
    }

    // تعطيل الزر أثناء الإرسال
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "جارٍ الإنشاء...";
    }

    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }

    console.log("📤 Emitting createPublicRoom with roomId:", code);

    socket.emit("createPublicRoom", {
        roomId: code,
        username: currentUser.name,
        title,
        location
    });

    console.log("✅ Emit sent, waiting for response...");

    // تنبيه بعد 5 ثواني إذا لم يتم الرد
    const timeoutId = setTimeout(() => {
        if (submitBtn && submitBtn.disabled) {
            console.warn("⚠️ No response from server after 5 seconds");
            submitBtn.disabled = false;
            submitBtn.textContent = "إنشاء الجلسة";
            if (errorEl) { errorEl.textContent = "انتظر قليلاً... حدث خطأ في الاتصال"; errorEl.style.display = "block"; }
        }
    }, 5000);
}

socket.on("publicRoomsList", (data) => {
    const container = document.getElementById("public-rooms-list");
    if (!container) return;

    const rooms = data.rooms || [];

    if (rooms.length === 0) {
        container.innerHTML = `<p style="opacity:.5;text-align:center;padding:24px;">لا توجد جلسات متاحة حالياً.<br>أنشئ جلسة جديدة لتبدأ!</p>`;
        return;
    }

    container.innerHTML = rooms.map(r => {
        const spotsText = r.spotsLeft === 1 ? "متبقي مقعد واحد" : `متبقي ${r.spotsLeft} مقاعد`;
        const locationText = r.location ? `<p style="opacity:.6;font-size:.85rem;margin:2px 0;">📍 ${r.location}</p>` : "";
        return `
            <div class="room-card" style="margin-bottom:12px;padding:14px;cursor:default;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <div>
                        <strong>${r.title}</strong>
                        ${locationText}
                        <p style="opacity:.6;font-size:.85rem;margin:4px 0;">منظم: ${r.hostName}</p>
                        <p style="opacity:.6;font-size:.85rem;margin:2px 0;">👥 ${r.playersCount}/4 — ${spotsText}</p>
                    </div>
                    <button onclick="joinPublicRoom('${r.roomId}')"
                        style="padding:8px 16px;border-radius:8px;background:#3a7bd5;color:#fff;border:none;cursor:pointer;font-size:.9rem;white-space:nowrap;">
                        انضمام
                    </button>
                </div>
            </div>
        `;
    }).join("");
});

function joinPublicRoom(roomId) {
    if (!currentUser) {
        showLoginPage();
        return;
    }
    socket.emit("joinRoom", {
        roomId,
        username: currentUser.name,
        avatar: currentUser.avatar || "images/default-avatar.png"
    });
}

// تحديث قائمة الجلسات عند إنشاء جلسة جديدة
socket.on("getPublicRoomsUpdate", () => {
    console.log("📢 تحديث قائمة الجلسات");
    socket.emit("getPublicRooms");
});

function toggleMobilePanel() {
    const panel = document.querySelector('.left-panel');
    const overlay = document.getElementById('mobile-panel-overlay');
    if (!panel) return;
    const isOpen = panel.classList.toggle('panel-open');
    if (overlay) overlay.classList.toggle('active', isOpen);
}

function saveGame() {
    if (!gameState) return;

    localStorage.setItem("mujabeedGame", JSON.stringify({
        gameState,
        currentPlayer,
        onlineRoomId,
        onlineRoomPlayers,
        selectedDecks,
        pendingCapture,
        objectionRank,
        objectionOwner,
        objectionPlayer
    }));

    saveLastRoom();
}

function loadGame() {
    const saved = localStorage.getItem("mujabeedGame");

    if (!saved) return false;

    const data = JSON.parse(saved);

    gameState = data.gameState;
    currentPlayer = data.currentPlayer;

    onlineRoomId = data.onlineRoomId || onlineRoomId;
    onlineRoomPlayers = data.onlineRoomPlayers || [];
    selectedDecks = data.selectedDecks || selectedDecks;

    pendingCapture = data.pendingCapture || null;
    objectionRank = data.objectionRank || null;
    objectionOwner = data.objectionOwner ?? null;
    objectionPlayer = data.objectionPlayer ?? null;

    renderGame();
    return true;
}

function clearSavedGame() {
    localStorage.removeItem("mujabeedGame");
}
window.onload = function () {
    const savedUser = localStorage.getItem("mujabeedUser");

    if (savedUser) {
        currentUser = JSON.parse(savedUser);

        const lastRoomId = localStorage.getItem("lastRoomId");

        if (lastRoomId) {
            onlineRoomId = String(lastRoomId).toUpperCase();

            socket.emit("joinRoom", {
                roomId: onlineRoomId,
                username: currentUser.name
            });

            if (localStorage.getItem("mujabeedGame")) {
                loadGame();
            }

            return;
        }

        if (!loadGame()) {
            showMainMenu();
        }
    } else {
        showEntryPage();
    }
};
function showExitConfirmDialog() {
    if (document.getElementById("exit-confirm-overlay")) {
        return;
    }

    document.body.insertAdjacentHTML("beforeend", `
        <div id="exit-confirm-overlay" class="exit-confirm-overlay">
            <div class="exit-confirm-modal">
                <div class="exit-confirm-icon">خروج</div>
                <h3>هل تريد الخروج من اللعبة؟</h3>
                <p>سيتم حفظ الحالة الحالية فقط إذا كنت تريد العودة لاحقاً.</p>
                <div class="exit-confirm-actions">
                    <button class="exit-confirm-cancel">إلغاء</button>
                    <button class="exit-confirm-confirm">خروج</button>
                </div>
            </div>
        </div>
    `);

    const overlay = document.getElementById("exit-confirm-overlay");
    const cancelBtn = overlay.querySelector(".exit-confirm-cancel");
    const confirmBtn = overlay.querySelector(".exit-confirm-confirm");

    const closeDialog = () => overlay.remove();

    cancelBtn.addEventListener("click", closeDialog);
    confirmBtn.addEventListener("click", () => {
        clearSavedGame();
        clearLastRoom();
        location.reload();
    });

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closeDialog();
        }
    });
}

function exitGame() {
    showExitConfirmDialog();
}
function quickPlayOnline() {
    if (!currentUser) {
        showLoginPage();
        return;
    }

    socket.emit("quickPlay", {
        username: currentUser.name
    });
    document.getElementById("waitingBox").style.display = "flex";
}


let onlinePlayersCount = 0;
let onlineBotsCount = 0;

socket.on("waiting", (data) => {
    document.getElementById("waitingCount").innerText =
data.count + " / 4";
});

socket.on("matchFound", (data) => {
    onlineRoomId = data.roomId;
    saveLastRoom();
    onlineRoomPlayers = data.players || [];

    myOnlineIndex = onlineRoomPlayers.findIndex(p => p?.id === socket.id);

    console.log("MATCH FOUND:", data);
    console.log("myOnlineIndex:", myOnlineIndex);

    startOnlineGame({
        ...data,
        playerIndex: myOnlineIndex
    });
});

socket.on("receiveGameState", (data) => {
    console.log("استلمت توزيع الهوست", data);

    if (data.roomId) {
        onlineRoomId = String(data.roomId).toUpperCase();
        saveLastRoom();
    }

    if (data.players) onlineRoomPlayers = data.players;
    if (data.currentPlayer !== undefined) currentPlayer = data.currentPlayer;

    pendingCapture = data.pendingCapture || null;
    objectionRank = data.objectionRank || null;
    objectionOwner = data.objectionOwner ?? null;
    objectionPlayer = data.objectionPlayer ?? null;

    startGame(data.gameState);
});

socket.on("roomCreated", (data) => {
    console.log("🎉 roomCreated event received:", data);
    
    onlineRoomId = data.roomId;
    saveLastRoom();
    myOnlineIndex = data.playerIndex;
    onlineRoomPlayers = data.players || [];
    isRoomHost = data.isHost;

    const joinError = document.getElementById("joinCodeError");
    if (joinError) joinError.textContent = "";

    console.log("📍 Going to lobby with roomId:", onlineRoomId);
    showLobby(data.roomId, onlineRoomPlayers, data.isHost);
});

socket.on("roomJoined", (data) => {
    if (!data?.roomId) return;

    console.log("🔔 roomJoined event:", data.roomId, "index:", data.playerIndex);
    
    onlineRoomId = String(data.roomId).toUpperCase();
    saveLastRoom();

    onlineRoomPlayers = data.players || [];
    myOnlineIndex = onlineRoomPlayers.findIndex(p => p?.id === socket.id);
    isRoomHost = data.isHost === true;

    console.log("✅ Updated onlineRoomId to:", onlineRoomId, "myIndex:", myOnlineIndex);

    if (data.gameState) {
        gameState = data.gameState;
        currentPlayer = data.currentPlayer || 0;

        pendingCapture = data.pendingCapture || null;
        objectionRank = data.objectionRank || null;
        objectionOwner = data.objectionOwner ?? null;
        objectionPlayer = data.objectionPlayer ?? null;

        saveGame();
        renderGame();
        return;
    }

    if (localStorage.getItem("mujabeedGame")) {
        loadGame();
        return;
    }

    showLobby(onlineRoomId, onlineRoomPlayers, isRoomHost);
});

socket.on("playerJoined", (data) => {
    if (!data?.roomId) return;
    if (data.roomId !== onlineRoomId) return; // تجاهل إذا كان من غرفة أخرى

    onlineRoomPlayers = data.players || [];
    
    // تحديث موقع اللاعب في الغرفة
    myOnlineIndex = onlineRoomPlayers.findIndex(p => p?.id === socket.id);
    
    console.log(`🎮 لاعب جديد انضم! عدد اللاعبين الآن: ${data.playersCount}, myIndex: ${myOnlineIndex}`);
    
    // تحديث واجهة اللوبي إذا كنا في الانتظار
    if (document.getElementById("waitingRoom")) {
        showLobby(onlineRoomId, onlineRoomPlayers, isRoomHost);
    }
});

socket.on("joinError", (data) => {
    const errorBox = document.getElementById("joinCodeError");

    if (errorBox) {
        errorBox.textContent = data?.message || "تعذر الانضمام إلى الغرفة";
    }

    showMessage(data?.message || "تعذر الانضمام إلى الغرفة", 4000);
});

socket.on("roomClosed", (data) => {
    clearLastRoom();
    onlineRoomId = null;
    onlineRoomPlayers = [];
    myOnlineIndex = 0;
    isRoomHost = false;
    showMessage("غادر منشئ الغرفة - تم إغلاق الغرفة", 4000);
    setTimeout(() => showMainMenu(), 500);
});

function startOnlineGame(data) {
    onlineRoomId = data.roomId;
    saveLastRoom();
    onlineRoomPlayers = data.players || [];
    myOnlineIndex = onlineRoomPlayers.findIndex(p => p?.id === socket.id);

    selectedDecks = data.decks || 5;
    console.log("عدد الرزمات قبل التوزيع:", selectedDecks);

    if (myOnlineIndex === 0) {
        // الهوست ينشئ اللعبة ويرسلها للآخرين
        startGame();

        socket.emit("sendGameState", {
            roomId: onlineRoomId,
            gameState: gameState
        });
    } else {
        // اللاعبون غير الهوست ينتظرون استقبال اللعبة من السيرفر
        console.log("في انتظار توزيع اللعبة من الهوست...");
    }
}

function syncOnlineGame() {
    if (roundEnded) return;
    if (!onlineRoomId || !gameState) return;

    socket.emit("syncGame", {
        roomId: onlineRoomId,
        gameState,
        currentPlayer,

        pendingCapture,
        objectionRank,
        objectionOwner,
        objectionPlayer
    });
}

socket.on("chatMessage", (data) => {
    appendChatMessage(data);
});

socket.on("leaderboardData", (data) => {
    console.log("📋 Received leaderboard data:", data);
    
    // تحديث أفضل لاعب أسبوعياً
    const weeklyName = document.getElementById("weekly-name");
    const weeklyPoints = document.getElementById("weekly-points");
    if (weeklyName && weeklyPoints) {
        weeklyName.textContent = data.weekly?.username || "—";
        weeklyPoints.textContent = (data.weekly?.weeklyPoints || 0) + " نقطة";
    }
    
    // تحديث أفضل لاعب شهرياً
    const monthlyName = document.getElementById("monthly-name");
    const monthlyPoints = document.getElementById("monthly-points");
    if (monthlyName && monthlyPoints) {
        monthlyName.textContent = data.monthly?.username || "—";
        monthlyPoints.textContent = (data.monthly?.monthlyPoints || 0) + " نقطة";
    }
    
    // تحديث أكثر اللاعبين فوزاً
    const winnerName = document.getElementById("winner-name");
    const winnerWins = document.getElementById("winner-wins");
    if (winnerName && winnerWins) {
        winnerName.textContent = data.winner?.username || "—";
        winnerWins.textContent = (data.winner?.wins || 0) + " انتصار";
    }
});

socket.on("leaderboardUpdated", () => {
    console.log("📊 Leaderboard updated, requesting new data...");
    socket.emit("getLeaderboard");
});

socket.on("gameSynced", (data) => {
    if (roundEnded) return;

    console.log("GAME SYNCED:", data);

    if (data.players) onlineRoomPlayers = data.players;

    gameState = data.gameState;
    currentPlayer = data.currentPlayer;

    pendingCapture = data.pendingCapture || null;
    objectionRank = data.objectionRank || null;
    objectionOwner = data.objectionOwner ?? null;
    objectionPlayer = data.objectionPlayer ?? null;

    saveGame();
    renderGame();

    if (pendingCapture && objectionRank && !objectionTimer) {
        startObjection(false);
    }
});

window.addEventListener("load", () => {
    try {
        const savedUser = localStorage.getItem(AUTH_STORAGE_KEY);

        if (savedUser) {
            currentUser = JSON.parse(savedUser);
            showMainMenu();
        } else {
            showEntryPage();
        }
    } catch (e) {
        console.error(e);
        clearAuthSession();
        showEntryPage();
    }
});