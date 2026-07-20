// =========================================================================
//  G.O.O.B.E.R PRO ENGINE v7.1 — OMNIPOTENT AUTONOMOUS AI BOT PANEL
//  EMN STUDIO — Tamamen AI kontrolüne bırakılmış, çökmeyen sunucu mimarisi
// =========================================================================

// --- DEPRECATED UYARILARINI BASTIRMA ---
process.noDeprecation = true;
process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning') return;
    console.warn(`[WARN] ${warning.name}: ${warning.message}`);
});

// --- SUNUCUYU ASLA ÇÖKERTME: GLOBAL GÜVENLİK AĞI ---
// Bu iki handler olmadan, mineflayer/pathfinder/pvp içindeki tek bir
// yakalanmamış hata TÜM sunucuyu (tüm botları) anında düşürür.
process.on('uncaughtException', (err) => {
    console.error('❌ [KRİTİK] Yakalanmamış hata (sunucu ayakta kalıyor):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ [KRİTİK] Yakalanmamış Promise reddi (sunucu ayakta kalıyor):', reason);
});

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mineflayer = require('mineflayer');
const Groq = require('groq-sdk');
const { Vec3 } = require('vec3');

// --- MINEFLAYER EKLENTİLERİ (eksik olsa bile sunucu çökmemeli) ---
function safeRequire(name) {
    try { return require(name); } catch (e) {
        console.error(`⚠️ Eklenti yüklenemedi: ${name} — ${e.message}`);
        return null;
    }
}
const pathfinderPkg = safeRequire('mineflayer-pathfinder');
const pvpPkg = safeRequire('mineflayer-pvp');
const collectBlockPkg = safeRequire('mineflayer-collectblock');
const autoEatModule = safeRequire('mineflayer-auto-eat');

const pathfinder = pathfinderPkg ? pathfinderPkg.pathfinder : null;
const Movements = pathfinderPkg ? pathfinderPkg.Movements : null;
const goals = pathfinderPkg ? pathfinderPkg.goals : null;
const pvpPlugin = pvpPkg ? pvpPkg.plugin : null;
const collectBlockPlugin = collectBlockPkg ? collectBlockPkg.plugin : null;
const autoEatPlugin = autoEatModule ? (autoEatModule.plugin || autoEatModule.loader || autoEatModule) : null;

// --- ORTAM DEĞİŞKENLERİ / GÜVENLİK ---
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_panel_key_2026';
const PORT = parseInt(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

if (JWT_SECRET === 'super_secret_panel_key_2026') {
    console.warn('⚠️ UYARI: Varsayılan JWT_SECRET kullanılıyor. Production ortamında JWT_SECRET env değişkenini mutlaka değiştirin.');
}

try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR oluşturulamadı:', e.message); }
try { if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([])); } catch (e) { console.error(e.message); }
try { if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, JSON.stringify([])); } catch (e) { console.error(e.message); }

const ORE_BASE_VALUE = {
    diamond_ore: 100, deepslate_diamond_ore: 100,
    emerald_ore: 90, deepslate_emerald_ore: 90,
    ancient_debris: 85,
    gold_ore: 40, deepslate_gold_ore: 40, nether_gold_ore: 35,
    iron_ore: 30, deepslate_iron_ore: 30,
    coal_ore: 10, deepslate_coal_ore: 10,
    obsidian: 25, gravel: 5
};

const HOSTILE_MOBS = [
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
    'slime', 'drowned', 'husk', 'stray', 'phantom', 'cave_spider', 'blaze', 'ghast', 'warden'
];

// --- GÜVENLİ DOSYA OKUMA/YAZMA (atomik yazım — yarım dosya/bozulma riski yok) ---
const readJSON = (file) => {
    try {
        if (!fs.existsSync(file)) return [];
        const data = fs.readFileSync(file, 'utf8').trim();
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error(`readJSON hatası (${file}):`, e.message);
        return [];
    }
};
const writeJSON = (file, data) => {
    try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.error(`writeJSON hatası (${file}):`, e.message);
        return false;
    }
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 30000 });

app.use(express.json());
app.use((err, req, res, next) => {
    // Bozuk JSON body vs. sunucuyu düşürmesin
    console.error('Express hata middleware:', err.message);
    res.status(400).json({ error: 'Geçersiz istek.' });
});
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map();       // botId -> instanceData
const presenceMap = new Map();      // userId -> { username, sockets:Set<socketId> }

// =========================================================================
//  YARDIMCI FONKSİYONLAR (hepsi try/catch ile korumalı)
// =========================================================================
function posKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function createWorldState(instanceData) {
    try {
        const { bot } = instanceData;
        if (!bot || !bot.inventory) return null;
        const items = bot.inventory.items();
        const countItem = (name) => items.filter(i => i.name.includes(name)).reduce((a, b) => a + b.count, 0);
        return {
            wood: countItem('log'),
            planks: countItem('planks'),
            cobble: countItem('cobblestone'),
            ironOre: countItem('iron_ore'),
            ironIngot: countItem('iron_ingot'),
            diamond: countItem('diamond'),
            wool: countItem('wool'),
            bed: items.some(i => i.name.includes('bed')),
            diamondPick: items.some(i => i.name.includes('diamond_pickaxe'))
        };
    } catch (e) { return null; }
}

async function autoEquipTool(instanceData, toolType) {
    try {
        const { bot } = instanceData;
        const item = bot.inventory.items().find(i => i.name.includes(toolType));
        if (item) await bot.equip(item, 'hand');
    } catch (e) { /* eşyayı kuşanamadı, sorun değil, devam eder */ }
}

async function autoEquipBestToolFor(instanceData, blockName) {
    try {
        const { bot } = instanceData;
        let toolType = 'hand';
        if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks')) toolType = 'axe';
        else if (blockName.includes('stone') || blockName.includes('cobblestone') || blockName.includes('ore') || blockName === 'obsidian') toolType = 'pickaxe';
        else if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand') || blockName.includes('gravel')) toolType = 'shovel';

        const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
        const bestTool = bot.inventory.items()
            .filter(i => i.name.includes(toolType))
            .sort((a, b) => tiers.findIndex(t => a.name.startsWith(t)) - tiers.findIndex(t => b.name.startsWith(t)))[0];

        if (bestTool) await bot.equip(bestTool, 'hand');
    } catch (e) { /* yoksay */ }
}

async function collectNearestDroppedItem(instanceData) {
    try {
        const { bot } = instanceData;
        if (!bot.entity) return;
        const nearestDrop = bot.nearestEntity(e => e.name === 'item' || (e.type === 'object' && e.objectType === 'Item'));
        if (nearestDrop && bot.entity.position.distanceTo(nearestDrop.position) < 12 && bot.pathfinder) {
            await bot.pathfinder.goto(new goals.GoalNear(nearestDrop.position.x, nearestDrop.position.y, nearestDrop.position.z, 0.5));
        }
    } catch (e) { /* yoksay */ }
}

async function craftBreadFromHayBale(instanceData) {
    try {
        const { bot } = instanceData;
        const hayCount = bot.inventory.items().filter(i => i.name === 'hay_block').reduce((sum, i) => sum + i.count, 0);
        if (hayCount <= 0) return;
        const mcData = require('minecraft-data')(bot.version);
        const wheatItem = mcData.itemsByName.wheat;
        if (!wheatItem) return;
        const wheatRecipe = bot.recipesFor(wheatItem.id, null, 1, null)[0];
        if (wheatRecipe) { try { await bot.craft(wheatRecipe, hayCount, null); } catch (e) {} }

        const wheatCount = bot.inventory.items().filter(i => i.name === 'wheat').reduce((sum, i) => sum + i.count, 0);
        if (wheatCount >= 3) {
            const breadItem = mcData.itemsByName.bread;
            if (!breadItem) return;
            const breadRecipe = bot.recipesFor(breadItem.id, null, 1, null)[0];
            if (breadRecipe) { try { await bot.craft(breadRecipe, Math.floor(wheatCount / 3), null); } catch (e) {} }
        }
    } catch (e) { /* yoksay */ }
}

function findMostLogicalOre(instanceData, oreNames) {
    try {
        const { bot } = instanceData;
        if (!bot || !bot.entity) return null;
        const blocks = bot.findBlocks({ matching: block => oreNames.includes(block.name), maxDistance: 40, count: 32 });

        const botPos = bot.entity.position;
        let bestBlock = null;
        let maxScore = -Infinity;

        for (const pos of blocks) {
            const block = bot.blockAt(pos);
            if (!block || instanceData.blockBlacklist.has(posKey(pos))) continue;

            let score = ORE_BASE_VALUE[block.name] || 5;
            score -= pos.distanceTo(botPos) * 0.8;

            if (score > maxScore) { maxScore = score; bestBlock = block; }
        }
        return bestBlock;
    } catch (e) { return null; }
}

// --- ENHANCED PVP ENGAGEMENT MOTORU ---
async function engageCloseCombat(instanceData, target) {
    try {
        const { bot } = instanceData;
        if (!bot || !bot.entity || !target || !target.position || !goals) return false;

        instanceData.pvpLocked = true;
        const botPos = bot.entity.position;
        const targetPos = target.position;
        const dist = botPos.distanceTo(targetPos);
        const now = Date.now();

        if (instanceData.lastTargetId === target.id && instanceData.lastKnownTargetPos) {
            const instantDist = instanceData.lastKnownTargetPos.distanceTo(targetPos);
            if (instantDist > 4.5 && target.name === 'enderman') {
                instanceData.teleportDetectedTick = 5;
                safeChat(bot, `⚠️ TELEPORT TESPİT EDİLDİ! Kaçamazsın ${target.name.toUpperCase()}! Takip moduna geçiliyor...`);
            }
        }
        instanceData.lastTargetId = target.id;
        instanceData.lastKnownTargetPos = targetPos.clone();

        const targetVelocity = target.velocity || new Vec3(0, 0, 0);
        const predictionTicks = instanceData.teleportDetectedTick > 0 ? 0 : (dist * 0.95);
        if (instanceData.teleportDetectedTick > 0) instanceData.teleportDetectedTick--;

        const predictedPos = targetPos.offset(
            targetVelocity.x * predictionTicks,
            target.name === 'enderman' ? 2.3 : 1.4 + (targetVelocity.y * predictionTicks),
            targetVelocity.z * predictionTicks
        );

        try { await bot.lookAt(predictedPos, true); } catch (e) {}

        if (dist > 3.6) {
            const goal = bot.pathfinder.goal;
            if (!goal || !goal.entity || goal.entity.id !== target.id) {
                bot.pathfinder.setGoal(new goals.GoalFollow(target, 0.8), true);
            }
            bot.setControlState("forward", true);
            bot.setControlState("sprint", true);
        } else {
            if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);

            const angle = (now / 110) % (2 * Math.PI);
            const cosVal = Math.cos(angle);

            if (dist < 2.85) { bot.setControlState("forward", false); bot.setControlState("back", true); }
            else if (dist > 3.05) { bot.setControlState("forward", true); bot.setControlState("back", false); }
            else { bot.setControlState("forward", false); bot.setControlState("back", false); }

            bot.setControlState("left", cosVal > 0.05);
            bot.setControlState("right", cosVal <= -0.05);
            bot.setControlState("sprint", true);

            if (bot.entity.isCollidedHorizontally && bot.entity.onGround) {
                bot.setControlState("jump", true);
                setTimeout(() => { try { if (bot && bot.entity) bot.setControlState("jump", false); } catch (e) {} }, 80);
            }

            if (now - instanceData.lastRecordedTick > 150) {
                instanceData.lastRecordedTick = now;
                const targetSpeed = target.velocity ? Math.sqrt(target.velocity.x ** 2 + target.velocity.z ** 2) : 0;
                const targetIsJumping = target.velocity ? target.velocity.y > 0.1 : false;

                instanceData.pvpMemoryBank.push({
                    timestamp: now, distance: dist, speed: targetSpeed,
                    isJumping: targetIsJumping, heldItem: target.heldItem ? target.heldItem.name : 'air'
                });

                if (instanceData.pvpMemoryBank.length > 100) instanceData.pvpMemoryBank = instanceData.pvpMemoryBank.slice(-100);
                try {
                    const file = path.join(DATA_DIR, `pvp_${instanceData.config.id}.json`);
                    writeJSON(file, instanceData.pvpMemoryBank);
                } catch (e) {}

                const jumpyPlayers = instanceData.pvpMemoryBank.filter(r => r.isJumping).length;
                const averageDist = instanceData.pvpMemoryBank.reduce((sum, r) => sum + r.distance, 0) / instanceData.pvpMemoryBank.length;

                if (jumpyPlayers > (instanceData.pvpMemoryBank.length * 0.4) && bot.entity.onGround && Math.random() < 0.6) {
                    bot.setControlState('jump', true);
                    setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 80);
                }
                if (averageDist < 2.2 && bot.entity.onGround) {
                    bot.setControlState("forward", false);
                    bot.setControlState("back", true);
                }
            }
        }

        if (bot.health < 12) {
            const gapple = bot.inventory.items().find(i => i.name === 'golden_apple');
            if (gapple) { try { await bot.equip(gapple, 'hand'); bot.activateItem(); } catch (e) {} }
        }

        const shield = bot.inventory.items().find(i => i.name === 'shield');
        if (shield) {
            if (dist < 4 && target.velocity && target.velocity.y < -0.1) {
                try { await bot.equip(shield, 'off-hand'); } catch (e) {}
                bot.setControlState('sneak', true);
            } else {
                bot.setControlState('sneak', false);
            }
        }

        if (now - instanceData.lastAttackTimestamp > 600) {
            try { bot.attack(target); } catch (e) {}
            instanceData.lastAttackTimestamp = now;
            return true;
        }
        return false;
    } catch (e) {
        console.error('engageCloseCombat hatası:', e.message);
        return false;
    }
}

function safeChat(bot, msg) {
    try { if (bot && bot._client && bot._client.socket && !bot._client.socket.destroyed) bot.chat(msg); } catch (e) {}
}

// --- WARDEN SİNSİ KAÇIŞ VE TEHLİKE YÖNETİMİ ---
async function behaviorFleeWarden(instanceData) {
    try {
        const { bot } = instanceData;
        if (!bot.entity || !goals) return false;
        const warden = bot.nearestEntity(e => e && e.name === 'warden' && e.position.distanceTo(bot.entity.position) < 40);

        if (warden) {
            const now = Date.now();
            const dist = bot.entity.position.distanceTo(warden.position);

            if (instanceData.lastWardenDist !== null && (now - instanceData.lastWardenTime) < 2000) {
                const deltaDist = instanceData.lastWardenDist - dist;
                const deltaTime = (now - instanceData.lastWardenTime) / 1000;
                const approachSpeed = deltaTime > 0 ? deltaDist / deltaTime : 0;
                if (approachSpeed > 4.5) instanceData.wardenChasing = true;
            }

            instanceData.lastWardenDist = dist;
            instanceData.lastWardenTime = now;
            instanceData.pvpLocked = false;
            instanceData.isEnraged = false;

            if (instanceData.wardenChasing) {
                if (!instanceData.isFleeing || bot.getControlState('sneak')) {
                    safeChat(bot, "😱 KAHRETSİN! Warden beni fark etti ve üzerime koşuyor! KAÇIYORUM! 🏃‍♂️💨");
                    instanceData.isFleeing = true;
                }
                bot.setControlState('sneak', false);
                bot.setControlState('sprint', true);
            } else {
                if (!instanceData.isFleeing) {
                    safeChat(bot, "🤫 Şşşt! Warden yakınlarda... Eğiliyorum, hiç bulaşmadan tüyeceğim.");
                    instanceData.isFleeing = true;
                }
                bot.setControlState('sneak', true);
                bot.setControlState('sprint', false);
            }

            const dx = bot.entity.position.x - warden.position.x;
            const dz = bot.entity.position.z - warden.position.z;
            const awayVec = new Vec3(dx, 0, dz).normalize().scaled(25);
            const targetSafePos = bot.entity.position.plus(awayVec);

            if (!bot.pathfinder.goal) {
                try { bot.pathfinder.setGoal(new goals.GoalNear(targetSafePos.x, bot.entity.position.y, targetSafePos.z, 2)); } catch (e) {}
            }
            return true;
        } else if (instanceData.isFleeing) {
            safeChat(bot, "Warden'dan başarıyla kurtuldum, tehlike geçti. 😎");
            bot.setControlState('sneak', false);
            bot.setControlState('sprint', false);
            instanceData.isFleeing = false;
            instanceData.wardenChasing = false;
            instanceData.lastWardenDist = null;
            if (bot.pathfinder) bot.pathfinder.setGoal(null);
        }
        return false;
    } catch (e) {
        console.error('behaviorFleeWarden hatası:', e.message);
        return false;
    }
}

// --- HEDEFLENMİŞ YAPAY ZEKA KURAL MOTORU / BEHAVIOR TREE ---
async function executeBehaviorTree(instanceData) {
    try {
        const { bot } = instanceData;
        if (!bot || !bot.entity || !goals) return;

        const state = createWorldState(instanceData);
        if (!state) return;

        if (await behaviorFleeWarden(instanceData)) return true;

        const bossTarget = bot.nearestEntity(e => e && e.name === 'enderman' && e.position.distanceTo(bot.entity.position) < 30);
        if (bossTarget && (!instanceData.isEnraged || instanceData.enrageTarget !== bossTarget)) {
            instanceData.isEnraged = true;
            instanceData.enrageTarget = bossTarget;
            safeChat(bot, `⚠️ HEDEF BULUNDU! Arama alanında bir ${bossTarget.name.toUpperCase()} tespit edildi! Saldırıyorum! 🤬🔥`);
        }

        if (instanceData.isEnraged && instanceData.enrageTarget) {
            if (!bot.entities[instanceData.enrageTarget.id] || instanceData.enrageTarget.health <= 0) {
                instanceData.isEnraged = false;
                instanceData.enrageTarget = null;
                instanceData.pvpLocked = false;
                safeChat(bot, "Hedef etkisiz hale getirildi!");
                try { bot.clearControlStates(); } catch (e) {}
                try { bot.pathfinder.setGoal(null); } catch (e) {}
            } else {
                await autoEquipTool(instanceData, "sword");
                await engageCloseCombat(instanceData, instanceData.enrageTarget);
                return true;
            }
        }

        if (bot.pvp && bot.pvp.target) {
            await engageCloseCombat(instanceData, bot.pvp.target);
            return true;
        }

        const pos = bot.entity.position;
        let lavaNear = false;
        let drowning = !!bot.entity.isInWater && bot.oxygenLevel <= 4;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const b = bot.blockAt(pos.offset(dx, dy, dz));
                    if (b && b.name === 'lava') lavaNear = true;
                }
            }
        }
        if (lavaNear || drowning || bot.health <= 6) {
            if (!bot.pathfinder.goal) {
                const rx = pos.x + (Math.random() - 0.5) * 20;
                const rz = pos.z + (Math.random() - 0.5) * 20;
                try { bot.pathfinder.setGoal(new goals.GoalXZ(rx, rz)); } catch (e) {}
            }
            return true;
        }

        if (instanceData.companionTarget) {
            const targetEntity = bot.players[instanceData.companionTarget]?.entity;
            if (targetEntity && bot.entity.position.distanceTo(targetEntity.position) > 3) {
                if (!bot.pathfinder.goal) {
                    try { bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 1.5), true); } catch (e) {}
                }
                return true;
            }
        }

        if (!instanceData.pvpLocked) {
            await collectNearestDroppedItem(instanceData);

            const sheep = bot.nearestEntity(e => e && e.name === 'sheep' && e.position.distanceTo(bot.entity.position) < 25);
            if (sheep && !state.bed && state.wool < 3) {
                await autoEquipTool(instanceData, "sword");
                try { bot.pathfinder.setGoal(new goals.GoalFollow(sheep, 1.5), true); } catch (e) {}
                if (bot.entity.position.distanceTo(sheep.position) < 3) { try { bot.attack(sheep); } catch (e) {} }
                return true;
            }

            const hayBaleBlock = bot.findBlock({ matching: b => b.name === 'hay_block', maxDistance: 30 });
            if (hayBaleBlock) {
                try {
                    await bot.pathfinder.goto(new goals.GoalNear(hayBaleBlock.position.x, hayBaleBlock.position.y, hayBaleBlock.position.z, 1.5));
                    await autoEquipBestToolFor(instanceData, 'hay_block');
                    if (bot.canDigBlock(hayBaleBlock)) {
                        await bot.dig(hayBaleBlock);
                        await craftBreadFromHayBale(instanceData);
                    }
                } catch (e) {}
                return true;
            }

            if (bot.time && (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23000)) {
                const bedBlock = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 15 });
                if (bedBlock) {
                    try {
                        await bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1.5));
                        await bot.sleep(bedBlock);
                    } catch (e) {}
                    return true;
                }
            }

            const hasIronPick = bot.inventory.items().some(i => i.name.includes('iron_pickaxe') || i.name.includes('diamond') || i.name.includes('netherite'));
            if (hasIronPick) {
                const diamond = findMostLogicalOre(instanceData, ['diamond_ore', 'deepslate_diamond_ore']);
                if (diamond) {
                    try {
                        await bot.pathfinder.goto(new goals.GoalLookAtBlock(diamond.position, bot.entity.dimension, { range: 4.5 }));
                        await autoEquipBestToolFor(instanceData, diamond.name);
                        if (bot.canDigBlock(diamond)) await bot.dig(diamond);
                    } catch (e) { instanceData.blockBlacklist.add(posKey(diamond.position)); }
                    return true;
                }
            }

            if (state.wood < 12 && state.cobble < 10) {
                const logBlock = bot.findBlock({ matching: b => b.name.includes('log'), maxDistance: 32 });
                if (logBlock) {
                    try {
                        await bot.pathfinder.goto(new goals.GoalLookAtBlock(logBlock.position, bot.entity.dimension, { range: 4.5 }));
                        await autoEquipBestToolFor(instanceData, logBlock.name);
                        if (bot.canDigBlock(logBlock)) await bot.dig(logBlock);
                    } catch (e) { instanceData.blockBlacklist.add(posKey(logBlock.position)); }
                    return true;
                }
            }
        }

        if (!bot.pathfinder.goal) {
            const rx = pos.x + (Math.random() - 0.5) * 30;
            const rz = pos.z + (Math.random() - 0.5) * 30;
            try { bot.pathfinder.setGoal(new goals.GoalXZ(rx, rz)); } catch (e) {}
        }
    } catch (e) {
        console.error('executeBehaviorTree hatası:', e.message);
    }
}

function checkAndAttackHostileMobs(instanceData) {
    try {
        const { bot } = instanceData;
        if (!bot || !bot.entity || (bot.pvp && bot.pvp.target)) return;

        const hostileMob = bot.nearestEntity(e =>
            e.type === 'mob' && HOSTILE_MOBS.includes(e.name) &&
            e.position.distanceTo(bot.entity.position) <= 50 && e.isValid
        );

        if (hostileMob && bot.pvp) {
            safeChat(bot, `⚠️ 50m alanda tehlike tespit edildi: ${hostileMob.name.toUpperCase()}! Saldırıya geçiliyor...`);
            bot.pvp.attack(hostileMob);
        }
    } catch (e) {
        console.error('checkAndAttackHostileMobs hatası:', e.message);
    }
}

// --- CREATİVE MOD YAPILAŞMA (BUILD) MOTORU ---
async function buildStructure(instanceData, blockNameStr) {
    try {
        const { bot } = instanceData;
        if (!bot || !bot.entity) return;

        const mcData = require('minecraft-data')(bot.version);
        const Item = require('prismarine-item')(bot.version);

        let searchName = String(blockNameStr || 'oak_planks').toLowerCase().replace(/ /g, '_');
        let blockType = mcData.itemsByName[searchName] ||
                        mcData.itemsByName[`${searchName}_planks`] ||
                        mcData.itemsByName[`${searchName}_block`] ||
                        mcData.itemsByName['oak_planks'];

        if (!blockType) { safeChat(bot, "Bu bloğu tanımıyorum, inşa edemiyorum."); return; }

        safeChat(bot, `Creative moda geçiyorum ve envanterime ${blockType.name} alıyorum...`);
        safeChat(bot, '/gamemode creative');
        await bot.waitForTicks(20);

        if (!bot.creative) { safeChat(bot, "Creative modu yetkim yok gibi görünüyor. OP yetkimi kontrol eder misin?"); return; }

        await bot.creative.setInventorySlot(36, new Item(blockType.id, 64));
        await bot.equip(blockType.id, 'hand');
        safeChat(bot, `🧱 ${blockType.name} elime alındı. Önüme inşa etmeye başlıyorum!`);

        const referencePosition = bot.entity.position.offset(1, -1, 0);
        const referenceBlock = bot.blockAt(referencePosition);

        if (referenceBlock && referenceBlock.name !== 'air') {
            await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
            safeChat(bot, "✅ Temel atıldı! Yapı prototipi başarılı.");
        } else {
            safeChat(bot, "Önümde blok koyabileceğim sağlam bir zemin yok, havada yapamam!");
        }
    } catch (err) {
        console.error("Build Error:", err.message);
        try { safeChat(instanceData.bot, "Eşyayı alırken veya koyarken bir sorun yaşadım. OP yetkim var mı?"); } catch (e) {}
    }
}

// =========================================================================
//  GROQ AI MESAJ İŞLEME — GÜVENİLİR JSON, RETRY, TIMEOUT, RATE-LIMIT
// =========================================================================
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} zaman aşımına uğradı`)), ms))
    ]);
}

function extractJSON(text) {
    // Model bazen açıklama/markdown ekleyebilir; JSON gövdesini güvenle ayıkla.
    if (!text) return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch (e) {}
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
    return null;
}

async function processAIMessage(instanceData, username, message) {
    const { bot, config } = instanceData;
    if (!config.aiEnabled || !config.apiKey) return;

    // Rate-limit: aynı bot için saniyede en fazla ~1 AI çağrısı (Groq kotasını / spam'i korur)
    const now = Date.now();
    if (instanceData.lastAICallTime && (now - instanceData.lastAICallTime) < 1200) return;
    instanceData.lastAICallTime = now;

    if (!instanceData.groqClient || instanceData.currentApiKey !== config.apiKey) {
        try {
            instanceData.groqClient = new Groq({ apiKey: config.apiKey });
            instanceData.currentApiKey = config.apiKey;
        } catch (e) {
            console.error('Groq istemcisi oluşturulamadı:', e.message);
            return;
        }
    }

    const personality = config.personality ? `Kişiliğin: ${config.personality}. Bu kişiliğe uygun konuş.` : '';

    const systemPrompt = `
Sen Minecraft'ta dünyanın en gelişmiş, otonom AI botusun. İsmin: ${config.username}.
Seninle konuşan oyuncu: ${username}. ${personality}

TALİMATLAR:
- Sana ne emredilirse HARFİYEN o eylemi seç; asla emirleri görmezden gelme veya kendi başına farklı bir eylem uydurma.
- "oyunu bitir", "speedrun yap", "odun topla" gibi bir talimat gelirse EYLEM OLARAK "beat_game" DÖNDÜR.
- Oyuncu "yaratıcı moda geç", "creative ol", "gm 1 yap" derse EYLEM OLARAK "gamemode_creative" DÖNDÜR.
- Oyuncu senden "yapı yap", "ev yap", "elmas bloktan kule yap", "tahtadan bir şey yap" gibi inşaat talimatları verirse EYLEM OLARAK "build_structure" DÖNDÜR ve json içindeki "blok_turu" alanına istediği materyali İngilizce ID olarak yaz (örn: diamond_block, oak_planks, stone).
- Oyuncu "dur", "yeter", "bırak" derse EYLEM OLARAK "stop" DÖNDÜR.
- Oyuncu "beni takip et", "peşimden gel" derse EYLEM OLARAK "follow" DÖNDÜR.
- Oyuncu "saldır", "şu canavarı öldür" derse EYLEM OLARAK "attack_mob" DÖNDÜR.
- Belirsiz veya eylem gerektirmeyen sohbet mesajlarında EYLEM OLARAK "none" DÖNDÜR.

ÇIKTI FORMATI KESİNLİKLE SADECE GEÇERLİ BİR JSON OBJESİ OLMALIDIR, başka hiçbir metin ekleme:
{
  "cevap": "Oyuncuya vereceğin Türkçe yanıt (roleplay yapabilirsin)",
  "eylem": "beat_game | stop | follow | attack_mob | gamemode_creative | build_structure | none",
  "blok_turu": "eğer eylem build_structure ise buraya ingilizce blok adı yazılır, yoksa boş bırakılır"
}
`;

    if (!instanceData.chatHistory || instanceData.chatHistory.length === 0) {
        instanceData.chatHistory = [{ role: "system", content: systemPrompt }];
    } else {
        // Kişilik/isim sonradan değişmiş olabilir — sistem promptunu her zaman güncel tut.
        instanceData.chatHistory[0] = { role: "system", content: systemPrompt };
    }

    instanceData.chatHistory.push({ role: "user", content: `${username}: ${message}` });
    if (instanceData.chatHistory.length > 9) {
        instanceData.chatHistory = [instanceData.chatHistory[0], ...instanceData.chatHistory.slice(-8)];
    }

    let aiResponse = null;
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !aiResponse; attempt++) {
        try {
            const completion = await withTimeout(
                instanceData.groqClient.chat.completions.create({
                    messages: instanceData.chatHistory,
                    model: "llama-3.3-70b-versatile",
                    response_format: { type: "json_object" },
                    temperature: 0.7
                }),
                15000,
                'Groq API isteği'
            );

            const resContent = completion?.choices?.[0]?.message?.content;
            const parsed = extractJSON(resContent);

            if (parsed && typeof parsed === 'object') {
                aiResponse = parsed;
                instanceData.chatHistory.push({ role: "assistant", content: resContent });
            } else if (attempt < MAX_ATTEMPTS) {
                // Modelin geçersiz JSON döndüğü durumda tekrar dene
                instanceData.chatHistory.push({ role: "user", content: "SADECE geçerli JSON formatında yanıt ver, başka hiçbir şey yazma." });
            }
        } catch (err) {
            console.error(`AI Hatası (deneme ${attempt}/${MAX_ATTEMPTS}):`, err.message);
            if (attempt === MAX_ATTEMPTS) {
                safeChat(bot, "🧠 Sinir ağımda geçici bir aksaklık oldu, birazdan tekrar dene.");
            }
        }
    }

    if (!aiResponse) return;

    try {
        if (aiResponse.cevap) safeChat(bot, String(aiResponse.cevap).slice(0, 250));

        switch (aiResponse.eylem) {
            case 'beat_game':
                instanceData.speedrunActive = true;
                safeChat(bot, "🚀 Goober Pro Engine v7.1 devrede! Hayatta kalma, gelişmiş PVP ve otonom döngü başlatıldı.");
                break;
            case 'gamemode_creative':
                safeChat(bot, "/gamemode creative");
                break;
            case 'build_structure':
                buildStructure(instanceData, aiResponse.blok_turu || 'oak_planks');
                break;
            case 'stop':
                instanceData.speedrunActive = false;
                instanceData.companionTarget = null;
                instanceData.isEnraged = false;
                instanceData.enrageTarget = null;
                try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (e) {}
                try { if (bot.pvp) bot.pvp.stop(); } catch (e) {}
                try { bot.clearControlStates(); } catch (e) {}
                break;
            case 'follow':
                instanceData.speedrunActive = false;
                instanceData.companionTarget = username;
                break;
            case 'attack_mob':
                checkAndAttackHostileMobs(instanceData);
                break;
        }
    } catch (e) {
        console.error('AI eylem uygulama hatası:', e.message);
    }
}

// --- OYUNCU LİSTESİ / ENVANTER YAYINI ---
function sendPlayerList(botId, botInstance) {
    try {
        if (!botInstance || !botInstance.players) return;
        const players = Object.keys(botInstance.players).map(username => ({ username }));
        io.to(botId).emit('playerList', players);
    } catch (e) {}
}

function sendInventory(botId, botInstance) {
    try {
        if (!botInstance || !botInstance.inventory) return;
        const items = botInstance.inventory.items().map(item => ({ name: item.name, count: item.count }));
        io.to(botId).emit('inventory', items);
    } catch (e) {}
}

// =========================================================================
//  AUTH API
// =========================================================================
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ error: 'Eksik bilgi.' });
        }
        if (username.length < 3 || password.length < 6) {
            return res.status(400).json({ error: 'Kullanıcı adı en az 3, şifre en az 6 karakter olmalı.' });
        }

        const users = readJSON(USERS_FILE);
        if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı adı alınmış.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        users.push({ id: 'usr_' + crypto.randomUUID(), username, password: hashedPassword });
        if (!writeJSON(USERS_FILE, users)) return res.status(500).json({ error: 'Kayıt sırasında bir hata oluştu.' });

        res.json({ success: true, message: 'Kayıt başarılı!' });
    } catch (e) {
        console.error('register hatası:', e.message);
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Eksik bilgi.' });

        const users = readJSON(USERS_FILE);
        const user = users.find(u => u.username === username);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Hatalı kullanıcı adı veya şifre.' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, username: user.username });
    } catch (e) {
        console.error('login hatası:', e.message);
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

const authenticateToken = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.sendStatus(401);

        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) return res.sendStatus(403);
            req.user = user;
            next();
        });
    } catch (e) {
        res.sendStatus(500);
    }
};

app.get('/api/bots', authenticateToken, (req, res) => {
    try {
        const bots = readJSON(BOTS_FILE).filter(b => b.ownerId === req.user.id);
        res.json(bots.map(b => ({ ...b, apiKey: b.apiKey ? '••••••••' : '', online: activeBots.has(b.id) })));
    } catch (e) {
        res.status(500).json({ error: 'Botlar okunamadı.' });
    }
});

app.post('/api/bots', authenticateToken, (req, res) => {
    try {
        const { name, host, port, authType, username, autoPassword, apiKey, aiEnabled, personality, autoStart } = req.body || {};
        if (!name || !username) return res.status(400).json({ error: 'Bot ismi ve Minecraft kullanıcı adı zorunlu.' });

        const bots = readJSON(BOTS_FILE);
        if (bots.find(b => b.name.toLowerCase() === String(name).toLowerCase())) {
            return res.status(400).json({ error: 'Bu isimde bir bot zaten mevcut.' });
        }

        const newBot = {
            id: 'bot_' + crypto.randomUUID(),
            ownerId: req.user.id,
            name,
            host: host || 'localhost',
            port: parseInt(port) || 25565,
            authType: authType || 'offline',
            username: username || 'Bot_' + Math.floor(Math.random() * 1000),
            autoPassword: autoPassword || '',
            apiKey: apiKey || '',
            aiEnabled: aiEnabled !== undefined ? !!aiEnabled : true,
            personality: personality || 'Standart',
            autoEat: true,
            autoAuth: true,
            autoStart: !!autoStart
        };
        bots.push(newBot);
        if (!writeJSON(BOTS_FILE, bots)) return res.status(500).json({ error: 'Bot kaydedilemedi.' });

        res.json({ success: true, bot: newBot });
    } catch (e) {
        console.error('bot oluşturma hatası:', e.message);
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

app.put('/api/bots/:id', authenticateToken, (req, res) => {
    try {
        const { host, port, apiKey, aiEnabled, personality, autoStart } = req.body || {};
        const bots = readJSON(BOTS_FILE);
        const botIndex = bots.findIndex(b => b.id === req.params.id && b.ownerId === req.user.id);
        if (botIndex === -1) return res.status(404).json({ error: 'Bot bulunamadı.' });

        if (host) bots[botIndex].host = host;
        if (port) bots[botIndex].port = parseInt(port) || bots[botIndex].port;
        if (apiKey !== undefined && apiKey !== '••••••••') bots[botIndex].apiKey = apiKey;
        if (aiEnabled !== undefined) bots[botIndex].aiEnabled = !!aiEnabled;
        if (personality !== undefined) bots[botIndex].personality = personality;
        if (autoStart !== undefined) bots[botIndex].autoStart = !!autoStart;

        if (!writeJSON(BOTS_FILE, bots)) return res.status(500).json({ error: 'Güncellenemedi.' });

        if (activeBots.has(req.params.id)) activeBots.get(req.params.id).config = bots[botIndex];

        res.json({ success: true, bot: bots[botIndex] });
    } catch (e) {
        console.error('bot güncelleme hatası:', e.message);
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

app.delete('/api/bots/:id', authenticateToken, (req, res) => {
    try {
        const bots = readJSON(BOTS_FILE);
        const idx = bots.findIndex(b => b.id === req.params.id && b.ownerId === req.user.id);
        if (idx === -1) return res.status(404).json({ error: 'Bot bulunamadı.' });

        stopBotInstance(req.params.id, true);
        bots.splice(idx, 1);
        writeJSON(BOTS_FILE, bots);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

// =========================================================================
//  MINEFLAYER MOTORU — OTOMATİK YENİDEN BAĞLANMA DAHİL
// =========================================================================
function startBotInstance(botConfig) {
    if (!botConfig) return null;
    if (activeBots.has(botConfig.id)) return activeBots.get(botConfig.id);

    let bot;
    try {
        bot = mineflayer.createBot({
            host: botConfig.host,
            port: botConfig.port,
            username: botConfig.username,
            auth: botConfig.authType === 'microsoft' ? 'microsoft' : 'offline',
            hideErrors: true
        });
    } catch (e) {
        console.error(`Bot oluşturulamadı (${botConfig.id}):`, e.message);
        io.to(botConfig.id).emit('status', { state: 'offline', message: 'Bot başlatılamadı: ' + e.message });
        return null;
    }

    // 'error' event'i için dinleyici YOKSA node bunu fırlatıp süreci çökertir. Asla eksik bırakma.
    bot.on('error', (err) => {
        console.error(`Bot hata (${botConfig.name}):`, err && err.message ? err.message : err);
        io.to(botConfig.id).emit('status', { state: 'error', message: 'Bağlantı hatası: ' + (err.message || 'bilinmeyen hata') });
    });

    if (pathfinder) bot.loadPlugin(pathfinder);
    if (pvpPlugin) bot.loadPlugin(pvpPlugin);
    if (collectBlockPlugin) bot.loadPlugin(collectBlockPlugin);
    if (autoEatPlugin) { try { bot.loadPlugin(autoEatPlugin); } catch (e) { console.error('auto-eat yüklenemedi:', e.message); } }

    const instanceData = {
        bot,
        ownerId: botConfig.ownerId,
        config: botConfig,
        chatHistory: [],
        speedrunActive: false,
        blockBlacklist: new Set(),
        pvpMemoryBank: [],
        lastTargetId: null,
        lastKnownTargetPos: null,
        teleportDetectedTick: 0,
        lastRecordedTick: 0,
        lastAttackTimestamp: 0,
        lastAICallTime: 0,
        pvpLocked: false,
        isEnraged: false,
        enrageTarget: null,
        isFleeing: false,
        wardenChasing: false,
        lastWardenDist: null,
        lastWardenTime: 0,
        companionTarget: null,
        intervals: [],
        manualStop: false,
        reconnectAttempts: 0
    };

    activeBots.set(botConfig.id, instanceData);

    bot.on('spawn', () => {
        try {
            instanceData.reconnectAttempts = 0;
            io.to(botConfig.id).emit('status', { state: 'online', message: 'Bot aktif! GOOBER PRO V7.1 Engine yüklendi.' });

            if (pathfinder && Movements) {
                const mcData = require('minecraft-data')(bot.version);
                const defaultMovements = new Movements(bot, mcData);
                defaultMovements.canDig = true;
                defaultMovements.scaffoldingBlocks = ['dirt', 'cobblestone', 'netherrack'];
                bot.pathfinder.setMovements(defaultMovements);
                if (bot.collectBlock) bot.collectBlock.movements = defaultMovements;
            }

            if (botConfig.authType === 'offline' && botConfig.autoAuth && botConfig.autoPassword) {
                setTimeout(() => safeChat(bot, `/login ${botConfig.autoPassword}`), 2000);
            }

            if (botConfig.autoEat && bot.autoEat) {
                try {
                    if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto();
                    else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable();
                } catch (e) {}
            }

            const scanInterval = setInterval(() => checkAndAttackHostileMobs(instanceData), 2000);
            const treeInterval = setInterval(() => {
                if (instanceData.speedrunActive) {
                    executeBehaviorTree(instanceData).catch(err => console.error("Behavior Tree Hatası:", err.message));
                }
            }, 200);

            instanceData.intervals.push(scanInterval, treeInterval);

            sendPlayerList(botConfig.id, bot);
            sendInventory(botConfig.id, bot);

            bot.inventory.on('updateSlot', () => sendInventory(botConfig.id, bot));
        } catch (e) {
            console.error('spawn handler hatası:', e.message);
        }
    });

    bot.on('move', () => {
        try {
            if (!bot.entity) return;
            const pos = bot.entity.position;
            io.to(botConfig.id).emit('botTelemetry', {
                x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1),
                yaw: bot.entity.yaw.toFixed(2), pitch: bot.entity.pitch.toFixed(2),
                health: bot.health ? Math.round(bot.health) : 20,
                food: bot.food ? Math.round(bot.food) : 20,
                currentAIAction: instanceData.isEnraged ? 'HEDEFE SALDIRIYOR' : (instanceData.isFleeing ? 'KAÇIYOR' : (instanceData.speedrunActive ? 'OTONOM GÖREV' : 'BEKLEMEDE'))
            });
        } catch (e) {}
    });

    bot.on('playerJoined', () => sendPlayerList(botConfig.id, bot));
    bot.on('playerLeft', () => sendPlayerList(botConfig.id, bot));

    bot.on('kicked', (reason) => {
        console.warn(`Bot sunucudan atıldı (${botConfig.name}):`, reason);
        io.to(botConfig.id).emit('status', { state: 'offline', message: 'Sunucudan atıldı: ' + String(reason).slice(0, 150) });
    });

    bot.on('chat', (username, message) => {
        try {
            io.to(botConfig.id).emit('chat', { username, message, time: new Date().toLocaleTimeString() });
            if (username === bot.username) return;
            if (instanceData.config.aiEnabled) {
                processAIMessage(instanceData, username, message).catch(err => console.error('processAIMessage hatası:', err.message));
            }
        } catch (e) {}
    });

    bot.on('end', () => {
        try {
            io.to(botConfig.id).emit('status', { state: 'offline', message: 'Bağlantı sonlandı.' });
            if (instanceData.intervals) instanceData.intervals.forEach(clearInterval);
            activeBots.delete(botConfig.id);

            // Manuel olarak durdurulmadıysa, otomatik ve kademeli olarak yeniden bağlan.
            if (!instanceData.manualStop) {
                instanceData.reconnectAttempts = (instanceData.reconnectAttempts || 0) + 1;
                const delay = Math.min(5000 * instanceData.reconnectAttempts, 60000);
                console.log(`🔁 ${botConfig.name} ${Math.round(delay / 1000)}sn sonra yeniden bağlanmayı deneyecek (deneme #${instanceData.reconnectAttempts}).`);
                io.to(botConfig.id).emit('status', { state: 'reconnecting', message: `${Math.round(delay / 1000)}sn sonra yeniden bağlanılıyor...` });
                setTimeout(() => {
                    const bots = readJSON(BOTS_FILE);
                    const freshConfig = bots.find(b => b.id === botConfig.id);
                    if (freshConfig) startBotInstance(freshConfig);
                }, delay);
            }
        } catch (e) {
            console.error('end handler hatası:', e.message);
        }
    });

    return instanceData;
}

function stopBotInstance(botId, permanent) {
    if (activeBots.has(botId)) {
        const instance = activeBots.get(botId);
        instance.manualStop = true; // otomatik yeniden bağlanmayı engelle
        if (instance.intervals) instance.intervals.forEach(clearInterval);
        try { if (instance.bot) instance.bot.end(); } catch (e) {}
        activeBots.delete(botId);
    }
}

// =========================================================================
//  SOCKET.IO — GERÇEK ZAMANLI KONTROL + ÇOK KULLANICILI PANEL ERİŞİMİ
// =========================================================================
function broadcastGlobalPanels() {
    try {
        const list = [];
        for (const [userId, entry] of presenceMap.entries()) {
            const userBots = readJSON(BOTS_FILE).filter(b => b.ownerId === userId && activeBots.has(b.id));
            userBots.forEach(b => list.push({ operator: entry.username, botId: b.id, botName: b.name }));
        }
        io.emit('globalPanelsUpdate', list);
    } catch (e) { console.error('broadcastGlobalPanels hatası:', e.message); }
}

io.on('connection', (socket) => {
    let currentBotId = null;
    let authedUser = null; // { id, username }

    socket.on('authenticate', (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            authedUser = { id: decoded.id, username: decoded.username };
            if (!presenceMap.has(authedUser.id)) presenceMap.set(authedUser.id, { username: authedUser.username, sockets: new Set() });
            presenceMap.get(authedUser.id).sockets.add(socket.id);
            broadcastGlobalPanels();
        } catch (e) { /* geçersiz token, sessizce yoksay */ }
    });

    socket.on('joinBotRoom', ({ botId, token }) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const bots = readJSON(BOTS_FILE);
            const botConfig = bots.find(b => b.id === botId && b.ownerId === decoded.id);
            if (!botConfig) return;

            currentBotId = botId;
            socket.join(botId);

            const isOnline = activeBots.has(botId);
            socket.emit('status', { state: isOnline ? 'online' : 'offline' });

            if (isOnline) {
                const instance = activeBots.get(botId);
                sendPlayerList(botId, instance.bot);
                sendInventory(botId, instance.bot);
            }
        } catch (e) { /* geçersiz token */ }
    });

    socket.on('startBot', () => {
        try {
            if (!currentBotId) return;
            const bots = readJSON(BOTS_FILE);
            const config = bots.find(b => b.id === currentBotId);
            if (config) {
                if (activeBots.has(config.id)) activeBots.get(config.id).manualStop = false;
                startBotInstance(config);
                broadcastGlobalPanels();
            }
        } catch (e) { console.error('startBot socket hatası:', e.message); }
    });

    socket.on('stopBot', () => {
        try {
            if (currentBotId) {
                stopBotInstance(currentBotId, false);
                broadcastGlobalPanels();
            }
        } catch (e) { console.error('stopBot socket hatası:', e.message); }
    });

    socket.on('directAICommand', (prompt) => {
        try {
            if (typeof prompt !== 'string' || !prompt.trim()) return;
            const instance = activeBots.get(currentBotId);
            if (instance) processAIMessage(instance, 'PANEL_OPERATOR', prompt.slice(0, 500)).catch(e => console.error(e.message));
        } catch (e) { console.error('directAICommand hatası:', e.message); }
    });

    socket.on('sendChat', (message) => {
        try {
            const instance = activeBots.get(currentBotId);
            if (instance && instance.bot && typeof message === 'string') safeChat(instance.bot, message.slice(0, 250));
        } catch (e) {}
    });

    socket.on('controlState', ({ control, state }) => {
        try {
            const instance = activeBots.get(currentBotId);
            const validControls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
            if (instance && instance.bot && validControls.includes(control)) {
                instance.bot.setControlState(control, !!state);
            }
        } catch (e) {}
    });

    socket.on('selectSlot', (slotIndex) => {
        try {
            const instance = activeBots.get(currentBotId);
            if (instance && instance.bot && Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 9) {
                instance.bot.setQuickBarSlot(slotIndex);
            }
        } catch (e) {}
    });

    socket.on('action', ({ type }) => {
        try {
            const instance = activeBots.get(currentBotId);
            if (!instance || !instance.bot) return;
            const bot = instance.bot;

            if (type === 'leftClick') {
                bot.swingArm('right');
                const entity = bot.entityAtCursor && bot.entityAtCursor();
                if (entity) bot.attack(entity);
            } else if (type === 'rightClick') {
                const block = bot.blockAtCursor && bot.blockAtCursor();
                if (block) bot.activateBlock(block);
            } else if (type === 'drop') {
                const item = bot.inventory.slots[bot.quickBarSlot + 36];
                if (item) bot.tossStack(item);
            }
        } catch (e) { console.error('action hatası:', e.message); }
    });

    // --- GERÇEK PANEL ERİŞİM İSTEĞİ SİSTEMİ (kullanıcılar arası) ---
    socket.on('requestPanelAccess', ({ targetBotId }) => {
        try {
            if (!authedUser || !targetBotId) return;
            const bots = readJSON(BOTS_FILE);
            const targetBot = bots.find(b => b.id === targetBotId);
            if (!targetBot) return;

            const ownerPresence = presenceMap.get(targetBot.ownerId);
            if (!ownerPresence) { socket.emit('accessRequestResult', { ok: false, message: 'Operatör şu an çevrimdışı.' }); return; }

            const requestId = crypto.randomUUID();
            instanceRequestRegistry.set(requestId, { fromSocketId: socket.id, fromUser: authedUser.username, targetBotId });

            ownerPresence.sockets.forEach(sockId => {
                io.to(sockId).emit('incomingAccessRequest', { requestId, fromUser: authedUser.username, botName: targetBot.name, botId: targetBot.id });
            });
        } catch (e) { console.error('requestPanelAccess hatası:', e.message); }
    });

    socket.on('responsePanelAccess', ({ requestId, approved }) => {
        try {
            const reqData = instanceRequestRegistry.get(requestId);
            if (!reqData) return;
            io.to(reqData.fromSocketId).emit('accessRequestResult', {
                ok: !!approved,
                message: approved ? `Erişim onaylandı: ${reqData.targetBotId}` : 'Erişim talebiniz reddedildi.',
                botId: approved ? reqData.targetBotId : null
            });
            instanceRequestRegistry.delete(requestId);
        } catch (e) { console.error('responsePanelAccess hatası:', e.message); }
    });

    socket.on('disconnect', () => {
        try {
            if (authedUser && presenceMap.has(authedUser.id)) {
                presenceMap.get(authedUser.id).sockets.delete(socket.id);
                if (presenceMap.get(authedUser.id).sockets.size === 0) presenceMap.delete(authedUser.id);
                broadcastGlobalPanels();
            }
        } catch (e) {}
    });
});

const instanceRequestRegistry = new Map(); // requestId -> { fromSocketId, fromUser, targetBotId }

// Periyodik olarak global panel listesini tazele (yeni katılan biri anlık görsün)
setInterval(broadcastGlobalPanels, 15000);

// =========================================================================
//  SUNUCU BAŞLANGICI — autoStart işaretli botları otomatik ayağa kaldır
// =========================================================================
server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` 🚀 GOOBER PRO OMNIPOTENT BOT PANEL: http://localhost:${PORT}`);
    console.log(`==================================================`);

    try {
        const bots = readJSON(BOTS_FILE);
        const autoStartBots = bots.filter(b => b.autoStart);
        if (autoStartBots.length > 0) {
            console.log(`🔁 ${autoStartBots.length} bot autoStart ile otomatik başlatılıyor...`);
            autoStartBots.forEach(b => startBotInstance(b));
        }
    } catch (e) {
        console.error('Otomatik başlatma hatası:', e.message);
    }
});