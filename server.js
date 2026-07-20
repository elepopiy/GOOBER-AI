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
const { Vec3 } = require('vec3');

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
const TRAIN_DATA_PATH = path.join(DATA_DIR, 'train.txt');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, JSON.stringify([]));

// Fallback Train Data rules if train.txt does not exist
const DEFAULT_SURVIVAL_DATA = {
    mob_danger_profiles: {
        warden: { danger_level: 10, action: "FLEE_SNEAK", min_distance: 40 },
        creeper: { danger_level: 8, action: "HIT_AND_RUN", min_distance: 6 },
        enderman: { danger_level: 7, action: "SHIELD_CRIT", min_distance: 15 },
        zombie: { danger_level: 3, action: "SPAM_CRIT", min_distance: 10 },
        skeleton: { danger_level: 4, action: "STRAFE_DODGE", min_distance: 15 }
    },
    harvest_logic: {
        wood: { blocks: ["oak_log", "birch_log", "spruce_log", "dark_oak_log"], preferred_tool: "axe", min_tier: "wooden" },
        iron_ore: { blocks: ["iron_ore", "deepslate_iron_ore"], preferred_tool: "pickaxe", min_tier: "stone" },
        diamond_ore: { blocks: ["diamond_ore", "deepslate_diamond_ore"], preferred_tool: "pickaxe", min_tier: "iron" }
    }
};

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

// --- BAZI YARDIMCI FONKSİYONLAR ---
function posKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function createWorldState(instanceData) {
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
}

async function autoEquipTool(instanceData, toolType) {
    const { bot } = instanceData;
    const item = bot.inventory.items().find(i => i.name.includes(toolType));
    if (item) {
        try { await bot.equip(item, 'hand'); } catch (e) {}
    }
}

async function autoEquipBestToolFor(instanceData, blockName) {
    const { bot } = instanceData;
    let toolType = 'hand';
    if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('planks')) toolType = 'axe';
    else if (blockName.includes('stone') || blockName.includes('cobblestone') || blockName.includes('ore') || blockName === 'obsidian') toolType = 'pickaxe';
    else if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand') || blockName.includes('gravel')) toolType = 'shovel';
    
    const bestTool = bot.inventory.items()
        .filter(i => i.name.includes(toolType))
        .sort((a, b) => {
            const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
            const aTier = tiers.findIndex(t => a.name.startsWith(t));
            const bTier = tiers.findIndex(t => b.name.startsWith(t));
            return aTier - bTier;
        })[0];
        
    if (bestTool) {
        try { await bot.equip(bestTool, 'hand'); } catch (e) {}
    }
}

async function collectNearestDroppedItem(instanceData) {
    const { bot } = instanceData;
    const nearestDrop = bot.nearestEntity(e => e.name === 'item' || (e.type === 'object' && e.objectType === 'Item'));
    if (nearestDrop && bot.entity.position.distanceTo(nearestDrop.position) < 12) {
        try {
            await bot.pathfinder.goto(new goals.GoalNear(nearestDrop.position.x, nearestDrop.position.y, nearestDrop.position.z, 0.5));
        } catch (e) {}
    }
}

async function craftBreadFromHayBale(instanceData) {
    const { bot } = instanceData;
    const hayCount = bot.inventory.items().filter(i => i.name === 'hay_block').reduce((sum, i) => sum + i.count, 0);
    if (hayCount > 0) {
        const mcData = require('minecraft-data')(bot.version);
        const wheatRecipe = bot.recipesFor(mcData.itemsByName.wheat.id, null, 1, null)[0];
        if (wheatRecipe) {
            try { await bot.craft(wheatRecipe, hayCount, null); } catch (e) {}
        }
        const wheatCount = bot.inventory.items().filter(i => i.name === 'wheat').reduce((sum, i) => sum + i.count, 0);
        if (wheatCount >= 3) {
            const breadRecipe = bot.recipesFor(mcData.itemsByName.bread.id, null, 1, null)[0];
            if (breadRecipe) {
                try { await bot.craft(breadRecipe, Math.floor(wheatCount / 3), null); } catch (e) {}
            }
        }
    }
}

function findMostLogicalOre(instanceData, oreNames) {
    const { bot } = instanceData;
    if (!bot || !bot.entity) return null;
    const blocks = bot.findBlocks({
        matching: block => oreNames.includes(block.name),
        maxDistance: 40,
        count: 32
    });

    const botPos = bot.entity.position;
    let bestBlock = null;
    let maxScore = -Infinity;

    for (const pos of blocks) {
        const block = bot.blockAt(pos);
        if (!block || instanceData.blockBlacklist.has(posKey(pos))) continue;

        let score = ORE_BASE_VALUE[block.name] || 5;
        const distance = pos.distanceTo(botPos);
        score -= distance * 0.8;

        if (score > maxScore) {
            maxScore = score;
            bestBlock = block;
        }
    }
    return bestBlock;
}

// --- ENHANCED PVP ENGAGEMENT MOTORU (Sin/Cos Orbital Strafing & Anti-Teleport Predictions) ---
async function engageCloseCombat(instanceData, target) {
    const { bot } = instanceData;
    if (!bot || !bot.entity || !target || !target.position) return false;

    instanceData.pvpLocked = true;
    const botPos = bot.entity.position;
    const targetPos = target.position;
    const dist = botPos.distanceTo(targetPos);
    const now = Date.now();

    if (instanceData.lastTargetId === target.id && instanceData.lastKnownTargetPos) {
        const instantDist = instanceData.lastKnownTargetPos.distanceTo(targetPos);
        if (instantDist > 4.5 && target.name === 'enderman') {
            instanceData.teleportDetectedTick = 5;
            bot.chat(`⚠️ TELEPORT TESPİT EDİLDİ! Kaçamazsın ${target.name.toUpperCase()}! Takip moduna geçiliyor...`);
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

    try { await bot.lookAt(predictedPos, true); } catch {}

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

        if (dist < 2.85) {
            bot.setControlState("forward", false);
            bot.setControlState("back", true);
        } else if (dist > 3.05) {
            bot.setControlState("forward", true);
            bot.setControlState("back", false);
        } else {
            bot.setControlState("forward", false);
            bot.setControlState("back", false);
        }

        bot.setControlState("left", cosVal > 0.05);
        bot.setControlState("right", cosVal <= -0.05);
        bot.setControlState("sprint", true);

        if (bot.entity.isCollidedHorizontally && bot.entity.onGround) {
            bot.setControlState("jump", true);
            setTimeout(() => { if (bot && bot.entity) bot.setControlState("jump", false); }, 80);
        }

        if (now - instanceData.lastRecordedTick > 150) {
            instanceData.lastRecordedTick = now;
            const targetSpeed = target.velocity ? Math.sqrt(target.velocity.x**2 + target.velocity.z**2) : 0;
            const targetIsJumping = target.velocity ? target.velocity.y > 0.1 : false;

            const currentRecord = {
                timestamp: now,
                distance: dist,
                speed: targetSpeed,
                isJumping: targetIsJumping,
                heldItem: target.heldItem ? target.heldItem.name : 'air'
            };

            instanceData.pvpMemoryBank.push(currentRecord);
            
            const file = path.join(DATA_DIR, `pvp_${instanceData.config.id}.json`);
            if (instanceData.pvpMemoryBank.length > 100) instanceData.pvpMemoryBank = instanceData.pvpMemoryBank.slice(-100);
            fs.writeFileSync(file, JSON.stringify(instanceData.pvpMemoryBank, null, 2));

            const jumpyPlayers = instanceData.pvpMemoryBank.filter(r => r.isJumping).length;
            const averageDist = instanceData.pvpMemoryBank.reduce((sum, r) => sum + r.distance, 0) / instanceData.pvpMemoryBank.length;

            if (jumpyPlayers > (instanceData.pvpMemoryBank.length * 0.4)) {
                if (bot.entity.onGround && Math.random() < 0.6) {
                    bot.setControlState('jump', true);
                    setTimeout(() => bot.setControlState('jump', false), 80);
                }
            }

            if (averageDist < 2.2 && bot.entity.onGround) {
                bot.setControlState("forward", false);
                bot.setControlState("back", true);
            }
        }
    }

    // In-combat health management
    if (bot.health < 12) {
        const gapple = bot.inventory.items().find(i => i.name === 'golden_apple');
        if (gapple) {
            await bot.equip(gapple, 'hand');
            bot.activateItem();
        }
    }

    // Smart Shield Management
    const shield = bot.inventory.items().find(i => i.name === 'shield');
    if (shield) {
        if (dist < 4 && target.velocity && target.velocity.y < -0.1) {
            await bot.equip(shield, 'off-hand');
            bot.setControlState('sneak', true);
        } else {
            bot.setControlState('sneak', false);
        }
    }

    if (now - instanceData.lastAttackTimestamp > 600) {
        bot.attack(target);
        instanceData.lastAttackTimestamp = now;
        return true;
    }
    return false;
}

// --- WARDEN SİNSİ KAÇIŞ VE TEHLİKE YÖNETİMİ ---
async function behaviorFleeWarden(instanceData) {
    const { bot } = instanceData;
    const warden = bot.nearestEntity(e => e && e.name === 'warden' && e.position.distanceTo(bot.entity.position) < 40);
    
    if (warden) {
        const now = Date.now();
        const dist = bot.entity.position.distanceTo(warden.position);
        
        if (instanceData.lastWardenDist !== null && (now - instanceData.lastWardenTime) < 2000) {
            const deltaDist = instanceData.lastWardenDist - dist;
            const deltaTime = (now - instanceData.lastWardenTime) / 1000;
            const approachSpeed = deltaDist / deltaTime;

            if (approachSpeed > 4.5) {
                instanceData.wardenChasing = true;
            }
        }
        
        instanceData.lastWardenDist = dist;
        instanceData.lastWardenTime = now;
        instanceData.pvpLocked = false;
        instanceData.isEnraged = false;

        if (instanceData.wardenChasing) {
            if (!instanceData.isFleeing || bot.getControlState('sneak')) {
                bot.chat("😱 KAHRETSİN! Warden beni fark etti ve üzerime koşuyor! KAÇIYORUM! 🏃‍♂️💨");
                instanceData.isFleeing = true;
            }
            bot.setControlState('sneak', false);
            bot.setControlState('sprint', true);
        } else {
            if (!instanceData.isFleeing) {
                bot.chat("🤫 Şşşt! Warden yakınlarda... Eğiliyorum, hiç bulaşmadan tüyeceğim.");
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
            try { bot.pathfinder.setGoal(new goals.GoalNear(targetSafePos.x, bot.entity.position.y, targetSafePos.z, 2)); } catch(e){}
        }

        return true; 
    } else if (instanceData.isFleeing) {
        bot.chat("Warden'dan başarıyla kurtuldum, tehlike geçti. 😎");
        bot.setControlState('sneak', false);
        bot.setControlState('sprint', false);
        instanceData.isFleeing = false;
        instanceData.wardenChasing = false;
        instanceData.lastWardenDist = null;
        bot.pathfinder.setGoal(null);
    }
    return false;
}

// --- HEDEFLENMİŞ YAPAY ZEKA KURAL MOTORU / BEHAVIOR TREE ---
async function executeBehaviorTree(instanceData) {
    const { bot } = instanceData;
    if (!bot || !bot.entity) return;

    const state = createWorldState(instanceData);
    if (!state) return;

    if (await behaviorFleeWarden(instanceData)) return true; 

    // Rage logic
    const bossTarget = bot.nearestEntity(e => e && e.name === 'enderman' && e.position.distanceTo(bot.entity.position) < 30);
    if (bossTarget && (!instanceData.isEnraged || instanceData.enrageTarget !== bossTarget)) {
        instanceData.isEnraged = true;
        instanceData.enrageTarget = bossTarget;
        bot.chat(`⚠️ HEDEF BULUNDU! Arama alanında bir ${bossTarget.name.toUpperCase()} tespit edildi! Saldırıyorum! 🤬🔥`);
    }

    if (instanceData.isEnraged && instanceData.enrageTarget) {
        if (!bot.entities[instanceData.enrageTarget.id] || instanceData.enrageTarget.health <= 0) { 
            instanceData.isEnraged = false;
            instanceData.enrageTarget = null;
            instanceData.pvpLocked = false;
            bot.chat("Hedef etkisiz hale getirildi!");
            bot.clearControlStates();
            bot.pathfinder.setGoal(null);
        } else {
            await autoEquipTool(instanceData, "sword");
            await engageCloseCombat(instanceData, instanceData.enrageTarget);
            return true;
        }
    }

    // Normal Combat Logic
    if (bot.pvp && bot.pvp.target) {
        await engageCloseCombat(instanceData, bot.pvp.target);
        return true;
    }

    // Emergency Procedures
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
            try { bot.pathfinder.setGoal(new goals.GoalXZ(rx, rz)); } catch(e){}
        }
        return true;
    }

    // Companion Logic
    if (instanceData.companionTarget) {
        const targetEntity = bot.players[instanceData.companionTarget]?.entity;
        if (targetEntity) {
            if (bot.entity.position.distanceTo(targetEntity.position) > 3) {
                if (!bot.pathfinder.goal) {
                    try { bot.pathfinder.setGoal(new goals.GoalFollow(targetEntity, 1.5), true); } catch(e){}
                }
                return true;
            }
        }
    }

    if (!instanceData.pvpLocked) {
        // Passive Hunting
        const sheep = bot.nearestEntity(e => e && e.name === 'sheep' && e.position.distanceTo(bot.entity.position) < 25);
        if (sheep && !state.bed && state.wool < 3) {
            await autoEquipTool(instanceData, "sword");
            try { bot.pathfinder.setGoal(new goals.GoalFollow(sheep, 1.5), true); } catch(e){}
            if (bot.entity.position.distanceTo(sheep.position) < 3) {
                bot.attack(sheep);
            }
            return true;
        }

        // Village/Harvest Logic
        const hayBaleBlock = bot.findBlock({ matching: b => b.name === 'hay_block', maxDistance: 30 });
        if (hayBaleBlock) {
            try {
                await bot.pathfinder.goto(new goals.GoalNear(hayBaleBlock.position.x, hayBaleBlock.position.y, hayBaleBlock.position.z, 1.5));
                await autoEquipBestToolFor(instanceData, 'hay_block');
                if (bot.canDigBlock(hayBaleBlock)) {
                    await bot.dig(hayBaleBlock);
                    await craftBreadFromHayBale(instanceData);
                }
            } catch(e){}
            return true;
        }

        // Sleeping Logic
        if (bot.time && (bot.time.timeOfDay >= 13000 && bot.time.timeOfDay <= 23000)) {
            const bedBlock = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 15 });
            if (bedBlock) {
                try {
                    await bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 1.5));
                    await bot.sleep(bedBlock);
                } catch(e){}
                return true;
            }
        }

        // Active Ore Hunting
        const hasIronPick = bot.inventory.items().some(i => i.name.includes('iron_pickaxe') || i.name.includes('diamond') || i.name.includes('netherite'));
        if (hasIronPick) {
            const diamond = findMostLogicalOre(instanceData, ['diamond_ore', 'deepslate_diamond_ore']);
            if (diamond) {
                try {
                    await bot.pathfinder.goto(new goals.GoalLookAtBlock(diamond.position, bot.entity.dimension, { range: 4.5 }));
                    await autoEquipBestToolFor(instanceData, diamond.name);
                    if (bot.canDigBlock(diamond)) await bot.dig(diamond);
                } catch(e){ instanceData.blockBlacklist.add(posKey(diamond.position)); }
                return true;
            }
        }

        // Standard Resource Progression Loop
        if (state.wood < 12 && state.cobble < 10) {
            const logBlock = bot.findBlock({ matching: b => b.name.includes('log'), maxDistance: 32 });
            if (logBlock) {
                try {
                    await bot.pathfinder.goto(new goals.GoalLookAtBlock(logBlock.position, bot.entity.dimension, { range: 4.5 }));
                    await autoEquipBestToolFor(instanceData, logBlock.name);
                    if (bot.canDigBlock(logBlock)) await bot.dig(logBlock);
                } catch(e){ instanceData.blockBlacklist.add(posKey(logBlock.position)); }
                return true;
            }
        }
    }

    // Default Exploration Behavior
    if (!bot.pathfinder.goal) {
        const rx = pos.x + (Math.random() - 0.5) * 30;
        const rz = pos.z + (Math.random() - 0.5) * 30;
        try { bot.pathfinder.setGoal(new goals.GoalXZ(rx, rz)); } catch(e){}
    }
}

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

    const mcData = require('minecraft-data')(bot.version);
    const Item = require('prismarine-item')(bot.version);
    
    let searchName = blockNameStr.toLowerCase().replace(' ', '_');
    let blockType = mcData.itemsByName[searchName] || 
                    mcData.itemsByName[`${searchName}_planks`] || 
                    mcData.itemsByName[`${searchName}_block`] || 
                    mcData.itemsByName['oak_planks'];

    bot.chat(`Creative moda geçiyorum ve envanterime ${blockType.name} alıyorum...`);
    bot.chat('/gamemode creative');
    await bot.waitForTicks(20);

    try {
        await bot.creative.setInventorySlot(36, new Item(blockType.id, 64));
        await bot.equip(blockType.id, 'hand');
        bot.chat(`🧱 ${blockType.name} elime alındı. Önüme inşa etmeye başlıyorum!`);

        const referencePosition = bot.entity.position.offset(1, -1, 0);
        const referenceBlock = bot.blockAt(referencePosition);
        
        if (referenceBlock && referenceBlock.name !== 'air') {
            await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
            bot.chat("✅ Temel atıldı! Yapı prototipi başarılı.");
        } else {
            bot.chat("Önümde blok koyabileceğim sağlam bir zemin yok, havada yapamam!");
        }
    } catch (err) {
        console.error("Build Error:", err.message);
        bot.chat("Eşyayı alırken veya koyarken bir sorun yaşadım. OP yetkim var mı?");
    }
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
                bot.chat("🚀 Goober Pro Engine v7.0 devrede! Hayatta kalma, gelişmiş PVP ve otonom döngü başlatıldı.");
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
                instanceData.companionTarget = null;
                bot.pathfinder.setGoal(null);
                bot.pvp.stop();
                bot.clearControlStates();
                break;
            case 'follow':
                instanceData.speedrunActive = false;
                instanceData.companionTarget = username;
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
        pvpLocked: false,
        isEnraged: false,
        enrageTarget: null,
        isFleeing: false,
        wardenChasing: false,
        lastWardenDist: null,
        lastWardenTime: 0,
        companionTarget: null,
        intervals: []
    };
    
    activeBots.set(botConfig.id, instanceData);

    bot.on('spawn', () => {
        io.to(botConfig.id).emit('status', { state: 'online', message: 'Bot aktif! GOOBER PRO V7 Engine yüklendi.' });

        const mcData = require('minecraft-data')(bot.version);
        const defaultMovements = new Movements(bot, mcData);
        defaultMovements.canDig = true; 
        defaultMovements.scafoldingBlocks = ['dirt', 'cobblestone', 'netherrack']; 
        bot.pathfinder.setMovements(defaultMovements);
        bot.collectBlock.movements = defaultMovements;

        if (botConfig.authType === 'offline' && botConfig.autoAuth && botConfig.autoPassword) {
            setTimeout(() => bot.chat(`/login ${botConfig.autoPassword}`), 2000);
        }

        if (botConfig.autoEat && bot.autoEat) {
            if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto();
            else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable();
        }

        const scanInterval = setInterval(() => {
            checkAndAttackHostileMobs(instanceData);
        }, 2000);

        const treeInterval = setInterval(() => {
            if (instanceData.speedrunActive) {
                executeBehaviorTree(instanceData).catch(err => console.error("Behavior Tree Hatası:", err.message));
            }
        }, 200);

        instanceData.intervals.push(scanInterval, treeInterval);
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
        if (instanceData.intervals) instanceData.intervals.forEach(clearInterval);
        activeBots.delete(botConfig.id);
    });

    return instanceData;
}

function stopBotInstance(botId) {
    if (activeBots.has(botId)) {
        const instance = activeBots.get(botId);
        if (instance.intervals) instance.intervals.forEach(clearInterval);
        instance.bot.end(); 
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