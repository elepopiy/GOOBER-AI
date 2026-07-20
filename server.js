// --- DEPRECATED UYARILARINI BASTIRMA ---
process.noDeprecation = true;
process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' && warning.message.includes('physicTick')) {
        return;
    }
    console.warn(warning.name, warning.message);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mineflayer = require('mineflayer');
const Groq = require('groq-sdk');
const vec3 = require('vec3');

// --- MINEFLAYER EKLENTİLERİ ---
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const collectBlock = require('mineflayer-collectblock').plugin;
const autoEatModule = require('mineflayer-auto-eat');
const autoEatPlugin = autoEatModule.plugin || autoEatModule.loader || autoEatModule;

const JWT_SECRET = 'super_secret_panel_key_2026';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, JSON.stringify([]));

const readJSON = (file) => {
    try {
        if (!fs.existsSync(file)) return [];
        const data = fs.readFileSync(file, 'utf8').trim();
        return data ? JSON.parse(data) : [];
    } catch { return []; }
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map();

// --- ZARARLI MOB LİSTESİ ---
const HOSTILE_MOBS = [
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 
    'slime', 'drowned', 'husk', 'stray', 'phantom', 'cave_spider', 'blaze', 'ghast'
];

// --- 50 BLOK TEHDİT TARAMASI VE SALDIRI SİSTEMİ ---
function checkAndAttackHostileMobs(instanceData) {
    const { bot } = instanceData;
    if (!bot || !bot.entity || bot.pvp.target) return;

    const hostileMob = bot.nearestEntity(e => 
        e.type === 'mob' && 
        HOSTILE_MOBS.includes(e.name) && 
        e.position.distanceTo(bot.entity.position) <= 50 &&
        e.isValid
    );

    if (hostileMob) {
        bot.chat(`⚠️ 50m alanda tehlike tespit edildi: ${hostileMob.name.toUpperCase()}! Saldırıya geçiliyor...`);
        bot.pvp.attack(hostileMob);
    }
}

// --- MINECRAFT BİTİRME (SPEEDRUN) ZİNCİRİ ---
async function runBeatGameLoop(instanceData) {
    const { bot } = instanceData;
    if (!instanceData.speedrunActive || !bot || !bot.entity) return;

    const mcData = require('minecraft-data')(bot.version);
    const defaultMovements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMovements);

    const items = bot.inventory.items();
    const count = (name) => items.filter(i => i.name.includes(name)).reduce((a, b) => a + b.count, 0);

    const wood = count('log');
    const cobble = count('cobblestone');
    const iron = count('iron_ingot') + count('raw_iron');
    const diamond = count('diamond');
    const blazeRod = count('blaze_rod');
    const enderPearl = count('ender_pearl');

    // ADIM 1: Odun Kırma ve Ağaç Keşfi
    if (wood < 12 && cobble < 10) {
        const logBlock = bot.findBlock({ matching: b => b.name.includes('log'), maxDistance: 64 });
        
        if (logBlock) {
            bot.chat(`🌲 Ağaç tespit edildi (${logBlock.position.x}, ${logBlock.position.y}, ${logBlock.position.z}). Odun kesmeye gidiyorum...`);
            bot.collectBlock.collect(logBlock, (err) => {
                if (!err) setTimeout(() => runBeatGameLoop(instanceData), 800);
                else setTimeout(() => runBeatGameLoop(instanceData), 2000);
            });
        } else {
            bot.chat("🔍 Yakında ağaç bulunamadı. Ağaç aramak için etrafı dolaşıyorum...");
            const randomX = bot.entity.position.x + (Math.random() - 0.5) * 50;
            const randomZ = bot.entity.position.z + (Math.random() - 0.5) * 50;
            
            bot.pathfinder.setGoal(new goals.GoalXZ(randomX, randomZ));
            setTimeout(() => runBeatGameLoop(instanceData), 7000);
        }
        return;
    }

    // ADIM 2: Taş ve Demir Çağı
    if (cobble < 20 || iron < 10) {
        bot.chat("🎯 [GÖREV 2/5] Taş ve Demir çağına geçiliyor. Madenler kazılıyor...");
        const ore = bot.findBlock({ matching: b => b.name.includes('iron_ore') || b.name === 'stone', maxDistance: 24 });
        if (ore) {
            bot.collectBlock.collect(ore, () => setTimeout(() => runBeatGameLoop(instanceData), 1000));
        } else {
            const rx = bot.entity.position.x + (Math.random() - 0.5) * 30;
            const rz = bot.entity.position.z + (Math.random() - 0.5) * 30;
            bot.pathfinder.setGoal(new goals.GoalXZ(rx, rz));
            setTimeout(() => runBeatGameLoop(instanceData), 5000);
        }
        return;
    }

    // ADIM 3: Elmas Ekipmanı
    if (diamond < 3) {
        bot.chat("🎯 [GÖREV 3/5] Elmas aranıyor...");
        const diaBlock = bot.findBlock({ matching: b => b.name.includes('diamond_ore'), maxDistance: 32 });
        if (diaBlock) {
            bot.collectBlock.collect(diaBlock, () => setTimeout(() => runBeatGameLoop(instanceData), 1000));
        }
        return;
    }

    // ADIM 4: Nether & Kaynak Toplama
    if (blazeRod < 7 || enderPearl < 12) {
        bot.chat("🎯 [GÖREV 4/5] Nether Portalına geçiş ve Ender Pearl / Blaze Rod avı...");
        return;
    }

    // ADIM 5: Stronghold & Ender Dragon
    bot.chat("🎯 [GÖREV 5/5] Stronghold aranıyor! Ender Dragon savaşına hazırlanılıyor...");
}

// --- GROQ AI MESAJ İŞLEME VE PROMPT YÖNETİMİ ---
async function processAIMessage(instanceData, username, message) {
    const { bot, config } = instanceData;
    if (!config.aiEnabled || !config.apiKey) return;

    if (!instanceData.groqClient || instanceData.currentApiKey !== config.apiKey) {
        instanceData.groqClient = new Groq({ apiKey: config.apiKey });
        instanceData.currentApiKey = config.apiKey;
    }

    const systemPrompt = `
Sen Minecraft'ta oyuncuyla birlikte oyunu bitirmeye (Speedrun yapmaya) odaklanmış otonom bir AI botsun. İsmin: ${config.username}.
Seninle konuşan oyuncu: ${username}.

TALİMATLAR:
- Oyuncu sana "oyunu bitir", "ağaç kes", "speedrun yap", "dragonu kes", "maden kaz", "odun topla" gibi bir talimat verirse EYLEM OLARAK KESİNLİKLE "beat_game" DÖNDÜR.
- "beat_game" eylemi tetiklendiğinde sen otomatik olarak sırasıyla:
  1. En yakın ağacı arayıp odun toplayacaksın (bulamazsan gezip arayacaksın).
  2. Taş ve demir çağına geçip maden kazacaksın.
  3. Nether ve Ender Dragon hazırlığı yapacaksın.

ÇIKTI FORMATI KESİNLİKLE SADECE GEÇERLİ BİR JSON OBJESİ OLMALIDIR:
{
  "cevap": "Oyuncuya vereceğin Türkçe yanıt",
  "eylem": "[beat_game, stop, follow, attack_mob, jump, none]"
}

Eylemler:
- "beat_game": Oyunu bitirme, ağaç kesme, maden ve otonom zinciri başlatma.
- "stop": Durma/iptal.
- "follow": Oyuncuyu takip etme.
- "attack_mob": Saldırı.
- "none": Sohbet.
`;

    try {
        if (!instanceData.chatHistory || instanceData.chatHistory.length === 0) {
            instanceData.chatHistory = [{ role: "system", content: systemPrompt }];
        }

        instanceData.chatHistory.push({ role: "user", content: `${username}: ${message}` });
        if (instanceData.chatHistory.length > 7) {
            instanceData.chatHistory = [instanceData.chatHistory[0], ...instanceData.chatHistory.slice(-6)];
        }

        const completion = await instanceData.groqClient.chat.completions.create({
            messages: instanceData.chatHistory,
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" }
        });

        const resContent = completion.choices[0].message.content;
        const aiResponse = JSON.parse(resContent);
        instanceData.chatHistory.push({ role: "assistant", content: resContent });

        if (aiResponse.cevap) bot.chat(aiResponse.cevap);

        switch (aiResponse.eylem) {
            case 'beat_game':
                instanceData.speedrunActive = true;
                bot.chat("🚀 Görev alındı! Oyunu bitirmek için ilk olarak odun aramaya başladım.");
                runBeatGameLoop(instanceData);
                break;

            case 'stop':
                instanceData.speedrunActive = false;
                bot.pathfinder.setGoal(null);
                bot.pvp.stop();
                bot.chat("Tüm otonom eylemler durduruldu.");
                break;

            case 'follow':
                instanceData.speedrunActive = false;
                const targetPlayer = bot.players[username]?.entity;
                if (targetPlayer) {
                    bot.pathfinder.setGoal(new goals.GoalFollow(targetPlayer, 2), true);
                }
                break;

            case 'attack_mob':
                checkAndAttackHostileMobs(instanceData);
                break;
        }

    } catch (err) {
        console.error("AI Hatası:", err.message);
    }
}

// --- AUTH API ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Eksik bilgi.' });

    const users = readJSON(USERS_FILE);
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı adı alınmış.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    users.push({ id: 'usr_' + Date.now(), username, password: hashedPassword });
    writeJSON(USERS_FILE, users);
    res.json({ success: true, message: 'Kayıt başarılı!' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.username === username);

    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Hatalı kullanıcı adı veya şifre.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

app.get('/api/bots', authenticateToken, (req, res) => {
    const bots = readJSON(BOTS_FILE).filter(b => b.ownerId === req.user.id);
    res.json(bots.map(b => ({ ...b, online: activeBots.has(b.id) })));
});

app.post('/api/bots', authenticateToken, (req, res) => {
    const { name, host, port, authType, username, autoPassword, apiKey, aiEnabled } = req.body;
    const bots = readJSON(BOTS_FILE);
    const newBot = {
        id: 'bot_' + Date.now(),
        ownerId: req.user.id,
        name,
        host: host || 'localhost',
        port: parseInt(port) || 25565,
        authType: authType || 'offline',
        username: username || 'Bot_' + Math.floor(Math.random() * 100),
        autoPassword: autoPassword || '',
        apiKey: apiKey || '',
        aiEnabled: aiEnabled !== undefined ? aiEnabled : true,
        autoEat: true,
        autoAuth: true
    };
    bots.push(newBot);
    writeJSON(BOTS_FILE, bots);
    res.json({ success: true, bot: newBot });
});

app.put('/api/bots/:id', authenticateToken, (req, res) => {
    const { host, port, apiKey, aiEnabled } = req.body;
    const bots = readJSON(BOTS_FILE);
    const botIndex = bots.findIndex(b => b.id === req.params.id && b.ownerId === req.user.id);

    if (botIndex === -1) return res.status(404).json({ error: 'Bot bulunamadı.' });

    bots[botIndex].host = host || bots[botIndex].host;
    bots[botIndex].port = parseInt(port) || bots[botIndex].port;
    bots[botIndex].apiKey = apiKey !== undefined ? apiKey : bots[botIndex].apiKey;
    bots[botIndex].aiEnabled = aiEnabled !== undefined ? aiEnabled : bots[botIndex].aiEnabled;

    writeJSON(BOTS_FILE, bots);

    if (activeBots.has(req.params.id)) {
        activeBots.get(req.params.id).config = bots[botIndex];
    }

    res.json({ success: true, bot: bots[botIndex] });
});

// --- MINEFLAYER MOTORU ---
function startBotInstance(botConfig) {
    if (activeBots.has(botConfig.id)) return activeBots.get(botConfig.id);

    const bot = mineflayer.createBot({
        host: botConfig.host,
        port: botConfig.port,
        username: botConfig.username,
        auth: botConfig.authType === 'microsoft' ? 'microsoft' : 'offline',
        hideErrors: true
    });

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectBlock);
    if (autoEatPlugin) bot.loadPlugin(autoEatPlugin);

    const instanceData = { bot, ownerId: botConfig.ownerId, config: botConfig, chatHistory: [], speedrunActive: false };
    activeBots.set(botConfig.id, instanceData);

    bot.on('spawn', () => {
        io.to(botConfig.id).emit('status', { state: 'online', message: 'Bot aktif! 50m koruma sistemi devrede.' });

        if (botConfig.authType === 'offline' && botConfig.autoAuth && botConfig.autoPassword) {
            setTimeout(() => bot.chat(`/login ${botConfig.autoPassword}`), 2000);
        }

        if (botConfig.autoEat && bot.autoEat) {
            if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto();
            else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable();
        }

        // 2 SANİYEDE BİR TEHDİT TARAMASI
        setInterval(() => {
            checkAndAttackHostileMobs(instanceData);
        }, 2000);
    });

    bot.on('move', () => {
        if (!bot.entity) return;
        const pos = bot.entity.position;
        io.to(botConfig.id).emit('botTelemetry', {
            x: pos.x.toFixed(1),
            y: pos.y.toFixed(1),
            z: pos.z.toFixed(1),
            yaw: bot.entity.yaw.toFixed(2),
            pitch: bot.entity.pitch.toFixed(2),
            health: bot.health,
            food: bot.food
        });
    });

    bot.on('chat', (username, message) => {
        io.to(botConfig.id).emit('chat', { username, message, time: new Date().toLocaleTimeString() });
        if (username === bot.username) return;

        if (instanceData.config.aiEnabled) {
            processAIMessage(instanceData, username, message);
        }
    });

    bot.on('end', () => {
        io.to(botConfig.id).emit('status', { state: 'offline', message: 'Ayrıldı.' });
        activeBots.delete(botConfig.id);
    });

    return instanceData;
}

function stopBotInstance(botId) {
    if (activeBots.has(botId)) {
        activeBots.get(botId).bot.quit();
        activeBots.delete(botId);
    }
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    let currentBotId = null;

    socket.on('joinBotRoom', ({ botId, token }) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const bots = readJSON(BOTS_FILE);
            const botConfig = bots.find(b => b.id === botId && b.ownerId === decoded.id);
            if (!botConfig) return;

            currentBotId = botId;
            socket.join(botId);
            socket.emit('status', { state: activeBots.has(botId) ? 'online' : 'offline' });
        } catch {}
    });

    socket.on('startBot', () => {
        if (!currentBotId) return;
        const bots = readJSON(BOTS_FILE);
        const config = bots.find(b => b.id === currentBotId);
        if (config) startBotInstance(config);
    });

    socket.on('stopBot', () => { if (currentBotId) stopBotInstance(currentBotId); });

    socket.on('directAICommand', (prompt) => {
        const instance = activeBots.get(currentBotId);
        if (instance) {
            processAIMessage(instance, 'PANEL_OPERATOR', prompt);
        }
    });

    socket.on('sendChat', (message) => {
        const instance = activeBots.get(currentBotId);
        if (instance && instance.bot) instance.bot.chat(message);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` 🚀 ADVANCED SPEEDRUN BOT PANEL: http://localhost:${PORT}`);
    console.log(`==================================================`);
});