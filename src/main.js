const fs = require('fs');
const readline = require('readline');
const { VK } = require('vk-io');
const dotenv = require('dotenv');
const { spawn } = require('child_process');
const { setInterval } = require('timers');

const CONFIG_FILE = '.env';
const COMMANDS_FILE = 'commands.json';
const EXCLUDE_FILE = 'exclude.json';

// Глобальные переменные
let commands = {};
let inviteActive = false;
let inviteStopped = false;
let currentProcess = null;
let chatMembersCache = new Map();
let botActive = true;
let excludeList = new Set();
let lastActivity = Date.now();

// Система мониторинга активности
const ACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 минут
const MONITOR_INTERVAL = 5 * 60 * 1000; // 5 минут

// Загрузка данных
function loadData() {
    try {
        // Загрузка команд
        if (fs.existsSync(COMMANDS_FILE)) {
            commands = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf-8'));
        }
        
        // Загрузка исключений
        if (fs.existsSync(EXCLUDE_FILE)) {
            const data = JSON.parse(fs.readFileSync(EXCLUDE_FILE, 'utf-8'));
            if (Array.isArray(data)) {
                excludeList = new Set(data);
            }
        }
    } catch (e) {
        console.error('Ошибка загрузки данных:', e);
    }
}

// Сохранение данных
function saveData() {
    try {
        fs.writeFileSync(COMMANDS_FILE, JSON.stringify(commands, null, 2));
        fs.writeFileSync(EXCLUDE_FILE, JSON.stringify([...excludeList], null, 2));
    } catch (e) {
        console.error('Ошибка сохранения данных:', e);
    }
}

// Настройка конфигурации
async function setupConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        let token, userId;
        
        try {
            const input = await new Promise(resolve => {
                rl.question('Введите токен или ссылку: ', resolve);
            });

            if (input.includes('access_token')) {
                const params = new URLSearchParams(input.split('#')[1]);
                token = params.get('access_token');
                userId = params.get('user_id');
            } else {
                token = input.trim();
            }

            if (!userId) {
                userId = await new Promise(resolve => {
                    rl.question('Введите USER_ID: ', resolve);
                });
            }
            
            fs.writeFileSync(CONFIG_FILE, 
                `VK_TOKEN="${token}"\nUSER_ID="${userId}"\nDELAY=0.5`
            );
            console.log('Конфигурация создана!');
        } catch (e) {
            console.error('Ошибка настройки:', e);
            process.exit(1);
        } finally {
            rl.close();
        }
    }
    
    dotenv.config();
    if (!process.env.DELAY) process.env.DELAY = 0.5;
    loadData();
}

// Получение участников чата с кэшированием
async function getChatMembers(vk, peerId) {
    try {
        // Проверка кэша
        if (chatMembersCache.has(peerId)) {
            const { timestamp, members } = chatMembersCache.get(peerId);
            if (Date.now() - timestamp < 30000) { // 30 секунд кэш
                return members;
            }
        }

        const response = await vk.api.messages.getConversationMembers({
            peer_id: peerId
        });
        
        const members = new Set(response.items.map(m => m.member_id));
        chatMembersCache.set(peerId, {
            timestamp: Date.now(),
            members
        });
        
        return members;
    } catch (e) {
        console.error('Ошибка получения участников чата:', e);
        return new Set();
    }
}

// Перезапуск бота
function restartBot() {
    console.log('🔄 Перезапуск бота...');
    const child = spawn(process.argv[0], [process.argv[1]], {
        detached: true,
        stdio: 'inherit'
    });
    child.unref();
    process.exit(0);
}

// Основная функция
async function main() {
    // Обработка критических ошибок
    process.on('uncaughtException', (err) => {
        console.error('❗ Необработанное исключение:', err);
        setTimeout(restartBot, 5000);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('❗ Необработанный промис:', promise, 'причина:', reason);
    });

    // Мониторинг активности
    setInterval(() => {
        if (Date.now() - lastActivity > ACTIVITY_TIMEOUT) {
            console.log('♻️ Перезапуск из-за неактивности');
            restartBot();
        }
    }, MONITOR_INTERVAL);

    await setupConfig();

    const vk = new VK({
        token: process.env.VK_TOKEN,
        apiMode: 'sequential', // Более стабильный режим
        apiLimit: 3, // Ограничение запросов
        apiWait: 1000, // Задержка между запросами
        language: 'ru'
    });

    // Жесткие мультикоманды (синонимы)
    const multicommands = {
        // Приглашение
        'инвайт': 'invitefriends',
        'пригласить': 'invitefriends',
        'добавить': 'invitefriends',
        'inv': 'invitefriends',
        'добавь': 'invitefriends',
        'пригл': 'invitefriends',
        'пригласи': 'invitefriends',
        
        // Подписчики
        'инвайтподписчиков': 'invitesubs',
        'подписки': 'invitesubs',
        'подписчики': 'invitesubs',
        'subs': 'invitesubs',
        'фолловеры': 'invitesubs',
        'подпис': 'invitesubs',
        
        // Все
        'инвайтвсех': 'inviteboth',
        'пригласитьвсех': 'inviteboth',
        'добавитьвсех': 'inviteboth',
        'всех': 'inviteboth',
        'все': 'inviteboth',
        'all': 'inviteboth',
        
        // Близкие друзья
        'инвайтблизких': 'inviteclose',
        'близкие': 'inviteclose',
        'closefriends': 'inviteclose',
        'лучшие': 'inviteclose',
        'близкиедрузья': 'inviteclose',
        
        // Кастомное
        'кастом': 'custominvite',
        'количество': 'custominvite',
        'число': 'custominvite',
        'выборочно': 'custominvite',
        
        // Управление
        'задержка': 'delay',
        'пауза': 'delay',
        'интервал': 'delay',
        
        // Остановка
        'стоп': 'stop',
        'остановить': 'stop',
        'отмена': 'stop',
        'прервать': 'stop',
        
        // Вкл/выкл
        'выключить': 'off',
        'деактивировать': 'off',
        'включить': 'on',
        'активировать': 'on',
        
        // Перезапуск
        'перезапуск': 'restart',
        'рестарт': 'restart',
        'обновить': 'restart',
        
        // Инфо
        'инфо': 'info',
        'информация': 'info',
        'статус': 'info',
        
        // Команды
        'команда': 'cmd',
        'создать': 'cmd',
        
        // Проверка
        'пинг': 'ping',
        'работаешь': 'ping',
        'статусбота': 'ping',
        
        // Помощь
        'помощь': 'help',
        'справка': 'help',
        'хелп': 'help',
        
        // Исключения
        'недобавлять': 'exclude',
        'исключить': 'exclude',
        'добавлять': 'include',
        'убрать': 'include',
        
        // Алиасы
        'команды': 'aliases',
        'показать': 'aliases',
        'показатькоманды': 'aliases',
        
        // Мультикоманды
        'мультикоманды': 'multicmd',
        'синонимы': 'multicmd',
        'командалии': 'multicmd'
    };

    // Команда help
    const helpText = `
🤖 Twixy-Invite-Bot(1.0.0)

👥 Приглашение:
  /друзья [кол-во] - Пригласить друзей
  /подписчики [кол-во] - Пригласить подписчиков
  /всех [кол-во] - Пригласить всех
  /близкие [кол-во] - Пригласить близких друзей
  /кастом [тип] [кол-во] - Выборочное приглашение
  (типы: friends, subs, both, close)

⚙️ Управление:
  /задержка [сек] - Установить задержку
  /стоп - Остановить приглашение
  /выключить - Деактивировать бота
  /включить - Активировать бота
  /перезапуск - Перезагрузить бота
  /инфо - Информация о боте

🛠️ Команды:
  /команда [основная команда] [ассоциация для команды которую вы хотите создать] - Создать ассоциации для основыых команд.
  /удалитькоманду [ассоциация] - Удалить ассоциацию для команд.
  /очиститькоманды - Удалить все ассоциации для команд.
  /команды - Показать все ассоциации для команд.
  /мультикоманды - Показать мультикоманды

🚫 Исключения:
  /недобавлять [пользователь] - Добавить в исключения
  /добавлять [пользователь] - Удалить из исключений

📌 Примеры:
  /друзья 50
  /задержка 0.8
  /команда help справка
  /недобавлять @username
`;

    // Обработка сообщений
    vk.updates.on('message_new', async (context) => {
        lastActivity = Date.now();
        
        if (context.senderId !== parseInt(process.env.USER_ID)) return;
        
        let text = context.text.trim();
        let command = null;
        let prefixUsed = '';

        // Поиск команды
        for (const prefix of ['!', '/', '.']) {
            if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
                const cmd = text.slice(prefix.length).split(' ')[0];
                const normalizedCmd = cmd.toLowerCase();
                command = multicommands[normalizedCmd] || commands[normalizedCmd] || normalizedCmd;
                prefixUsed = prefix;
                break;
            }
        }

        // Критические команды
        const criticalCommands = new Set(['on', 'help', 'restart']);
        if (!botActive && !criticalCommands.has(command)) return;

        try {
            // Обновление контекста
            context.prefix = prefixUsed;
            
            switch (command) {
                case 'invitefriends': {
                    const count = parseInt(context.text.split(' ')[1]) || 0;
                    if (count <= 0) {
                        context.send('❌ Укажите число больше 0');
                        return;
                    }
                    await handleInviteFriends(context, vk, count);
                    break;
                }
                    
                case 'invitesubs': {
                    const count = parseInt(context.text.split(' ')[1]) || 0;
                    if (count <= 0) {
                        context.send('❌ Укажите число больше 0');
                        return;
                    }
                    await handleInviteSubs(context, vk, count);
                    break;
                }
                    
                case 'inviteboth': {
                    const count = parseInt(context.text.split(' ')[1]) || 0;
                    if (count <= 0) {
                        context.send('❌ Укажите число больше 0');
                        return;
                    }
                    await handleInviteBoth(context, vk, count);
                    break;
                }
                    
                case 'inviteclose': {
                    const count = parseInt(context.text.split(' ')[1]) || 0;
                    if (count <= 0) {
                        context.send('❌ Укажите число больше 0');
                        return;
                    }
                    await handleInviteClose(context, vk, count);
                    break;
                }
                    
                case 'custominvite': {
                    const parts = context.text.split(' ').slice(1);
                    if (parts.length < 2) {
                        context.send('❌ Используйте: /custominvite [тип] [кол-во]\nТипы: friends, subs, both, close');
                        return;
                    }
                    
                    const [type, countStr] = parts;
                    const count = parseInt(countStr);
                    
                    if (!['friends', 'subs', 'both', 'close'].includes(type)) {
                        context.send('❌ Неверный тип! Допустимые: friends, subs, both, close');
                        return;
                    }
                    
                    if (isNaN(count) || count <= 0) {
                        context.send('❌ Укажите число больше 0');
                        return;
                    }
                    
                    switch (type) {
                        case 'friends': await handleInviteFriends(context, vk, count); break;
                        case 'subs': await handleInviteSubs(context, vk, count); break;
                        case 'both': await handleInviteBoth(context, vk, count); break;
                        case 'close': await handleInviteClose(context, vk, count); break;
                    }
                    break;
                }
                    
                case 'delay': {
                    const delay = parseFloat(context.text.split(' ')[1]);
                    if (isNaN(delay) || delay <= 0 || delay > 10) {
                        context.send('❌ Укажите число от 0.1 до 10');
                        return;
                    }
                    process.env.DELAY = delay;
                    fs.appendFileSync(CONFIG_FILE, `\nDELAY=${delay}`);
                    context.send(`✅ Задержка обновлена: ${delay} сек`);
                    break;
                }
                    
                case 'cmd': {
                    const args = context.text.slice(context.prefix.length + command.length + 1).trim().split(/\s+/);
                    if (args.length < 2) {
                        context.send('❌ Используйте: /cmd [основная команда] [ассоциация для команды которую вы хотите создать]\nПример: /cmd help справка');
                        return;
                    }
                    
                    const [target, alias] = args;
                    if (!target || !alias) {
                        context.send('❌ Укажите основную команду и ассоциацию для команд.');
                        return;
                    }
                    
                    commands[alias.toLowerCase()] = target;
                    saveData();
                    context.send(`✅ Ассоциации для команды создана: "${alias}" → "${target}"`);
                    break;
                }
                    
                case 'delalias': 
                case 'удалитькоманду': {
                    const alias = context.text.split(' ')[1]?.toLowerCase();
                    if (!alias) {
                        context.send('❌ Укажите ассоциацию для команд для удаления');
                        return;
                    }
                    
                    if (commands[alias]) {
                        delete commands[alias];
                        saveData();
                        context.send(`✅ Ассоциации для команды "${alias}" удален`);
                    } else {
                        context.send(`❌ Ассоциации для команды "${alias}" не найден`);
                    }
                    break;
                }
                    
                case 'clearaliases': 
                case 'очиститькоманды': {
                    if (Object.keys(commands).length === 0) {
                        context.send('ℹ️ Нет ассоциации для команд для удаления');
                        return;
                    }
                    
                    commands = {};
                    saveData();
                    context.send('✅ Все ассоциации для команд удалены');
                    break;
                }
                    
                case 'stop': {
                    if (inviteActive) {
                        inviteStopped = true;
                        if (currentProcess) clearTimeout(currentProcess);
                        inviteActive = false;
                        context.send('🛑 Приглашение остановлено');
                    } else {
                        context.send('ℹ️ Нет активных процессов');
                    }
                    break;
                }
                    
                case 'off': {
                    botActive = false;
                    context.send('🔴 Бот деактивирован. Используйте /on для активации');
                    break;
                }
                    
                case 'on': {
                    botActive = true;
                    context.send('🟢 Бот активирован!');
                    break;
                }
                    
                case 'restart': {
                    context.send('🔄 Перезагрузка...');
                    setTimeout(restartBot, 500);
                    break;
                }
                    
                case 'ping': {
                    context.send('✅ Бот работает! Статус: ' + (botActive ? 'АКТИВЕН' : 'ДЕАКТИВИРОВАН'));
                    break;
                }
                    
                case 'info': {
                    context.send(`
🤖 Информация о боте и текуших настройках:
Twixy-invite-bot(JS)
Версия:1.0.0
Текушая задержка: ${process.env.DELAY} сек
Статус Бота: ${botActive ? 'АКТИВЕН' : 'ДЕАКТИВИРОВАН'}
Ваши личные ассоциации для команд: ${Object.keys(commands).length}
Исключений пользователей которых не нужно добавлять: ${excludeList.size}
Активных процессов: ${inviteActive ? 'Активно приглашение' : 'Нет'}
                    `);
                    break;
                }
                    
                case 'help': {
                    context.send(helpText);
                    break;
                }
                    
                case 'exclude': {
                    const userInput = context.text.slice(context.prefix.length + command.length + 1).trim();
                    if (!userInput) {
                        context.send('❌ Укажите пользователя');
                        return;
                    }
                    
                    // Реализация resolveUser будет ниже
                    const userId = await resolveUser(vk, context, userInput);
                    if (!userId) {
                        context.send('❌ Не удалось определить пользователя');
                        return;
                    }
                    
                    excludeList.add(userId);
                    saveData();
                    context.send(`✅ Пользователь ${userId} добавлен в исключения`);
                    break;
                }
                    
                case 'include': {
                    const userInput = context.text.slice(context.prefix.length + command.length + 1).trim();
                    if (!userInput) {
                        context.send('❌ Укажите пользователя');
                        return;
                    }
                    
                    const userId = await resolveUser(vk, context, userInput);
                    if (!userId) {
                        context.send('❌ Не удалось определить пользователя');
                        return;
                    }
                    
                    if (excludeList.delete(userId)) {
                        saveData();
                        context.send(`✅ Пользователь ${userId} удален из исключений`);
                    } else {
                        context.send(`ℹ️ Пользователь ${userId} не найден в исключениях`);
                    }
                    break;
                }
                    
                case 'aliases': {
                    if (Object.keys(commands).length === 0) {
                        context.send('ℹ️ Ассоциации для команд не созданы');
                        return;
                    }
                    
                    let aliasesText = '📝 Ассоциации для команд.:\n';
                    for (const [alias, target] of Object.entries(commands)) {
                        aliasesText += `- ${alias} → ${target}\n`;
                    }
                    context.send(aliasesText);
                    break;
                }
                    
                case 'multicmd': {
                    let multicmdText = '🔠 Мультикоманды:\n';
                    const sorted = Object.entries(multicommands).sort();
                    
                    for (const [synonym, command] of sorted) {
                        multicmdText += `- ${synonym} → ${command}\n`;
                    }
                    context.send(multicmdText);
                    break;
                }
                    
                
                default: {
                    if (commands[command]) {
                        const newText = context.prefix + commands[command] + 
                                      context.text.slice(context.prefix.length + command.length);
                        vk.updates.emit('message_new', {
                            ...context,
                            text: newText
                        });
                    }
                }
            }
        } catch (e) {
            console.error('Ошибка команды:', e);
            if (botActive) {
                context.send(`❌ Ошибка: ${e.message}`);
            }
        }
    });

    // Запуск бота
    try {
        await vk.updates.start();
        console.log('✅ Бот запущен! Ожидание команд...');
        console.log('👤 USER_ID:', process.env.USER_ID);
        console.log('⏱️ Задержка:', process.env.DELAY + ' сек');
        console.log('🔄 Мониторинг активности включен');
    } catch (e) {
        console.error('🚨 Ошибка запуска:', e);
        setTimeout(restartBot, 5000);
    }
}

// Разрешение пользователей
async function resolveUser(vk, context, input) {
    // Ответ на сообщение
    if (context.replyMessage) {
        return context.replyMessage.senderId;
    }
    
    // Пересланные сообщения
    if (context.forwards.length > 0) {
        return context.forwards[0].senderId;
    }
    
    // Упоминание
    if (input.startsWith('[')) {
        const match = input.match(/\[(id|public|club)(\d+)\|/);
        if (match) return parseInt(match[2]);
    }
    
    // ID
    if (/^\d+$/.test(input)) {
        return parseInt(input);
    }
    
    // @username
    if (input.startsWith('@')) {
        try {
            const resolved = await vk.api.utils.resolveScreenName({
                screen_name: input.slice(1)
            });
            if (resolved && resolved.object_id && resolved.type === 'user') {
                return resolved.object_id;
            }
        } catch (e) {
            console.error('Ошибка разрешения:', e);
        }
    }
    
    return null;
}

// Общая функция приглашения
async function inviteUsers(context, vk, users, typeText) {
    if (inviteActive) {
        context.send('⚠️ Уже выполняется приглашение! Используйте /stop для отмены');
        return;
    }
    
    inviteActive = true;
    inviteStopped = false;
    let criticalError = false;

    try {
        const chatId = context.peerId;
        const chatMembers = await getChatMembers(vk, chatId);
        
        await context.send(
            `🤖 Начинаю приглашение: ${typeText}\n` +
            `👥 Пользователей: ${users.length}\n` +
            `⏱ Задержка: ${process.env.DELAY} сек\n` +
            `🕒 Подождите...`
        );

        let success = 0;
        let skipped = 0;
        
        for (const userId of users) {
            if (inviteStopped) {
                console.log('⏹ Приглашение остановлено');
                break;
            }
            
            // Исправленная строка:
            if (chatMembers.has(userId)) {
                skipped++;
                continue;
            }
            
            if (excludeList.has(userId)) {
                skipped++;
                continue;
            }

            try {
                await vk.api.messages.addChatUser({
                    chat_id: chatId - 2000000000,
                    user_id: userId
                });

                success++;
                chatMembers.add(userId);
                
                await new Promise(resolve => {
                    currentProcess = setTimeout(resolve, process.env.DELAY * 1000);
                });
            } catch (e) {
                skipped++;
                
                if ([925, 15, 935].includes(e.code)) {
                    criticalError = true;
                    break;
                }
                
                if (e.code === 6) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        if (criticalError) {
            context.send('🛑 Процесс остановлен из-за ошибки приглашения');
        } else {
            context.send(
                `📊 Результат:\n` +
                `✅ Успешно: ${success}\n` +
                `⏩ Пропущено: ${skipped}\n` +
                `🛑 Остановлено: ${inviteStopped ? 'Да' : 'Нет'}`
            );
        }
    } catch (e) {
        console.error('🚨 Ошибка приглашения:', e);
        context.send(`❌ Критическая ошибка: ${e.message}`);
    } finally {
        inviteActive = false;
        inviteStopped = false;
        currentProcess = null;
    }
}
// Приглашение друзей
async function handleInviteFriends(context, vk, count = 0) {
    try {
        const friends = await vk.api.friends.get({});
        let users = friends.items.filter(id => !excludeList.has(id));
        
        if (users.length === 0) {
            context.send('ℹ️ Нет друзей для приглашения');
            return;
        }
        
        if (count > 0 && count < users.length) {
            users = users.slice(0, count);
        }
        
        await inviteUsers(context, vk, users, 'друзья');
    } catch (e) {
        context.send(`❌ Ошибка: ${e.message}`);
    }
}

// Приглашение подписчиков
async function handleInviteSubs(context, vk, count = 0) {
    try {
        const followers = await vk.api.users.getFollowers({ count: 1000 });
        let users = followers.items.filter(id => !excludeList.has(id));
        
        if (users.length === 0) {
            context.send('ℹ️ Нет подписчиков для приглашения');
            return;
        }
        
        if (count > 0 && count < users.length) {
            users = users.slice(0, count);
        }
        
        await inviteUsers(context, vk, users, 'подписчики');
    } catch (e) {
        context.send(`❌ Ошибка: ${e.message}`);
    }
}

// Приглашение всех
async function handleInviteBoth(context, vk, count = 0) {
    try {
        const [friends, followers] = await Promise.all([
            vk.api.friends.get({}),
            vk.api.users.getFollowers({ count: 1000 })
        ]);
        
        let users = [...new Set([...friends.items, ...followers.items])]
            .filter(id => !excludeList.has(id));
        
        if (users.length === 0) {
            context.send('ℹ️ Нет пользователей для приглашения');
            return;
        }
        
        if (count > 0 && count < users.length) {
            users = users.slice(0, count);
        }
        
        await inviteUsers(context, vk, users, 'друзья+подписчики');
    } catch (e) {
        context.send(`❌ Ошибка: ${e.message}`);
    }
}

// Приглашение близких друзей (ИСПРАВЛЕННАЯ)
async function handleInviteClose(context, vk, count = 0) {
    try {
        const friends = await vk.api.friends.get({ 
            fields: 'lists',
            count: 1000
        });
        
        // Фильтрация близких друзей
        const closeFriends = friends.items.filter(friend => 
            friend.lists && friend.lists.includes(1)
        );
        
        let users = closeFriends
            .map(f => f.id)
            .filter(id => !excludeList.has(id));
        
        if (users.length === 0) {
            context.send('ℹ️ Нет близких друзей для приглашения');
            return;
        }
        
        if (count > 0 && count < users.length) {
            users = users.slice(0, count);
        }
        
        await inviteUsers(context, vk, users, 'близкие друзья');
    } catch (e) {
        context.send(`❌ Ошибка: ${e.message}`);
    }
}

// Запуск
main().catch(err => {
    console.error('🚨 Критическая ошибка при запуске:', err);
    setTimeout(restartBot, 5000);
});