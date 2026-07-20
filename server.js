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

const HOSTILE_MOBS = [
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 
    'slime', 'drowned', 'husk', 'stray', 'phantom', 'cave_spider', 'blaze', 'ghast'
];

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

// --- CREATİVE MOD YAPILAŞMA (BUILD) MOTORU ---
async function buildStructure(instanceData, blockNameStr) {
    const { bot } = instanceData;
    if (!bot || !bot.entity) return;

    // Hedeflenen bloğu oyun veritabanında bul (varsayılan: oak_planks)
    const mcData = require('minecraft-data')(bot.version);
    const Item = require('prismarine-item')(bot.version);
    
    // AI genelde Türkçe veya genel İngilizce çeviri gönderebilir, eşleştirme yapıyoruz
    let searchName = blockNameStr.toLowerCase().replace(' ', '_');
    let blockType = mcData.itemsByName[searchName] || 
                    mcData.itemsByName[`${searchName}_planks`] || 
                    mcData.itemsByName[`${searchName}_block`] || 
                    mcData.itemsByName['oak_planks'];

    bot.chat(`Creative moda geçiyorum ve envanterime ${blockType.name} alıyorum...`);
    
    // Creative moda geçişi garantiye al
    bot.chat('/gamemode creative');
    await bot.waitForTicks(20); // Sunucunun oyun modunu güncellemesi için bekle

    try {
        // Envanterin 36. slotuna (Hotbar'ın ilk sekmesi) 64 adet istenen bloğu yerleştir (CREATIVE HACK)
        await bot.creative.setInventorySlot(36, new Item(blockType.id, 64));
        await bot.equip(blockType.id, 'hand');
        bot.chat(`🧱 ${blockType.name} elime alındı. Önüme inşa etmeye başlıyorum!`);

        // Basit yapı yerleştirme örneği: Botun baktığı yönün hemen önüne ve altına blok koyar
        const referencePosition = bot.entity.position.offset(1, -1, 0);
        const referenceBlock = bot.blockAt(referencePosition);
        
        if (referenceBlock && referenceBlock.name !== 'air') {
            const vec = require('vec3');
            await bot.placeBlock(referenceBlock, new vec(0, 1, 0));
            bot.chat("✅ Temel atıldı! Yapı prototipi başarılı.");
        } else {
            bot.chat("Önümde blok koyabileceğim sağlam bir zemin yok, havada yapamam!");
        }
    } catch (err) {
        console.error("Build Error:", err.message);
        bot.chat("Eşyayı alırken veya koyarken bir sorun yaşadım. OP yetkim var mı?");
    }
}

async function runBeatGameLoop(instanceData) {
    const { bot } = instanceData;
    if (!instanceData.speedrunActive || !bot || !bot.entity) return;

    const items = bot.inventory.items();
    const count = (name) => items.filter(i => i.name.includes(name)).reduce((a, b) => a + b.count, 0);

    const wood = count('log');
    const cobble = count('cobblestone');
    
    if (wood < 12 && cobble < 10) {
        const logBlock = bot.findBlock({ matching: b => b.name.includes('log'), maxDistance: 64 });
        
        if (logBlock) {
            bot.chat(`🌲 Ağaç tespit edildi. Odun kesmeye gidiyorum...`);
            bot.collectBlock.collect(logBlock, (err) => {
                // Hata durumunda takılı kalmamak için hedefi temizle ve biraz bekle
                if (!err) {
                    setTimeout(() => runBeatGameLoop(instanceData), 800);
                } else {
                    bot.chat("Bu ağaca ulaşamadım, başka arayacağım.");
                    setTimeout(() => runBeatGameLoop(instanceData), 3000);
                }
            });
        } else {
            const randomX = bot.entity.position.x + (Math.random() - 0.5) * 50;
            const randomZ = bot.entity.position.z + (Math.random() - 0.5) * 50;
            bot.pathfinder.setGoal(new goals.GoalXZ(randomX, randomZ));
            setTimeout(() => runBeatGameLoop(instanceData), 7000);
        }
        return;
    }
    
    bot.chat("Maden aşamasına geçiliyor...");
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
Sen Minecraft'ta dünyanın en gelişmiş, otonom AI botusun. İsmin: ${config.username}.
Seninle konuşan oyuncu: ${username}.

TALİMATLAR:
- "oyunu bitir", "speedrun yap", "odun topla" gibi bir talimat gelirse EYLEM OLARAK "beat_game" DÖNDÜR.
- Oyuncu "yaratıcı moda geç", "creative ol", "gm 1 yap" derse EYLEM OLARAK "gamemode_creative" DÖNDÜR.
- Oyuncu senden "yapı yap", "ev yap", "elmas bloktan kule yap", "tahtadan bir şey yap" gibi inşaat talimatları verirse EYLEM OLARAK "build_structure" DÖNDÜR ve json içindeki "blok_turu" alanına istediği materyali İngilizce ID olarak yaz (örn: diamond_block, oak_planks, stone).

ÇIKTI FORMATI KESİNLİKLE SADECE GEÇERLİ BİR JSON OBJESİ OLMALIDIR:
{
  "cevap": "Oyuncuya vereceğin Türkçe yanıt (roleplay yapabilirsin)",
  "eylem": "beat_game | stop | follow | attack_mob | gamemode_creative | build_structure | none",
  "blok_turu": "eğer eylem build_structure ise buraya ingilizce blok adı yazılır, yoksa boş bırakılır"
}
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
            case 'gamemode_creative':
                bot.chat("/gamemode creative");
                break;
            case 'build_structure':
                const blockReq = aiResponse.blok_turu || 'oak_planks';
                buildStructure(instanceData, blockReq);
                break;
            case 'stop':
                instanceData.speedrunActive = false;
                bot.pathfinder.setGoal(null);
                bot.pvp.stop();
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
// [Değişiklik yok, önceki kod ile aynı]
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
        io.to(botConfig.id).emit('status', { state: 'online', message: 'Bot aktif! Sistemler devrede.' });

        // --- PATHFINDER VE HAREKET AYARLARI (DÜZELTİLDİ) ---
        const mcData = require('minecraft-data')(bot.version);
        const defaultMovements = new Movements(bot, mcData);
        defaultMovements.canDig = true; // Engelleri kırmasına izin ver
        defaultMovements.scafoldingBlocks = ['dirt', 'cobblestone', 'netherrack']; // Blok koyarak tırmanabilir
        bot.pathfinder.setMovements(defaultMovements);
        
        // collectBlock için hareketi eşitle (Ağaç kırmada takılmaması için)
        bot.collectBlock.movements = defaultMovements;

        if (botConfig.authType === 'offline' && botConfig.autoAuth && botConfig.autoPassword) {
            setTimeout(() => bot.chat(`/login ${botConfig.autoPassword}`), 2000);
        }

        if (botConfig.autoEat && bot.autoEat) {
            if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto();
            else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable();
        }

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
        activeBots.get(botId).bot.end(); // TypeError çökmesi çözüldü (quit yerine end)
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
    console.log(` 🚀 ADVANCED OMNIPOTENT BOT PANEL: http://localhost:${PORT}`);
    console.log(`==================================================`);
});