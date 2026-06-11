const { Telegraf, Markup } = require('telegraf'); 
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// === КОНФИГУРАЦИЯ ===
// Збережи тут свої токени, якщо вони зміняться
const BOT_TOKEN = '7968411624:AAH0HCiht5fWUlBvzlGZtUy2zuWodGoe5Z0'; 
const CRYPTO_BOT_TOKEN = '593822:AAyKKvZzs6f8zjghQDX4zSth5dWabQUwy2Q'; 
const PORT = process.env.PORT || 3000; // Змінено для деплою 24/7 (Render/Railway підставлять свій порт)

const bot = new Telegraf(BOT_TOKEN);

// Наше надежное хранилище сессий по Telegram ID
const userSessions = {};

// === БАЗА ДАННЫХ FIREBASE ===
const serviceAccount = require('./firebase-key.json');

admin.initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore(); 
const usersCollection = db.collection('users');

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Функция отрисовки Главного Меню
async function sendMainMenu(ctx, textPrefix = "") {
    const text = textPrefix + `🏠 Ласкаво просимо до головного меню! Оберіть потрібну функцію зі списку ниже! 😊`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('👤 Мій профіль', 'menu_profile')],
        [
            Markup.button.callback('📱 Завантажити застосунок', 'menu_download'),
            Markup.button.callback('🔑 Код авторизації', 'menu_token')
        ],
        [Markup.button.callback('💎 Придбати підписку (прибрати червоні написи)', 'menu_buy')],
        [Markup.button.callback('🤝 Реферальна система', 'menu_referral')],
        [Markup.button.callback('🔄 Змінити ПІБ/фото/підпис', 'menu_change_data')]
    ]);

    await ctx.reply(text, keyboard);
}

// === ЛОГИКА РЕГИСТРАЦИИ И ОБНОВЛЕНИЯ ===

bot.start(async (ctx) => {
    const targetId = String(ctx.from.id);
    const startPayload = ctx.payload; 

    try {
        const userDoc = await usersCollection.doc(targetId).get();

        if (userDoc.exists) {
            return sendMainMenu(ctx, "Ви вже зареєстровані! ");
        }

        userSessions[targetId] = {
            step: 'photo',
            referrer_id: startPayload && !isNaN(startPayload) ? String(startPayload) : null,
            is_updating: false
        };

        await ctx.reply(
            `👋 Вітаємо! Почнімо реєстрацію.\n\n1️⃣ **Надішліть вашу фотографію.**\n\nПісля этого я попрошу вказати ПІБ та дату народження.`
        );
    } catch (e) {
        console.error('Помилка при старті реєстрації:', e);
        await ctx.reply('❌ Сталася помилка при зверненні до бази даних.');
    }
});

bot.on('photo', async (ctx) => {
    const targetId = String(ctx.from.id);
    const session = userSessions[targetId];

    if (!session || session.step !== 'photo') return;

    const photo = ctx.message.photo.pop();
    session.photo = photo.file_id;
    session.step = 'name';

    await ctx.reply(`Введіть ПІБ.\n\nПриклад:\nІванов Іван Іванович`);
});

bot.on('text', async (ctx) => {
    const targetId = String(ctx.from.id);
    const session = userSessions[targetId];

    if (!session) return;

    if (session.step === 'name') {
        session.fullName = ctx.message.text.trim();
        session.step = 'birth';
        return ctx.reply(`Введіть дату народження.\n\nПриклад:\n15.08.2008`);
    }

    if (session.step === 'birth') {
        const birthDate = ctx.message.text.trim();
        
        try {
            if (session.is_updating) {
                await usersCollection.doc(targetId).update({
                    full_name: session.fullName,
                    birth_date: birthDate,
                    photo_file_id: session.photo
                });

                await ctx.reply('🎉 Ваші дані успішно оновлено!');
                delete userSessions[targetId]; 
                return await sendMainMenu(ctx);
            }

            const token = crypto.randomUUID();
            const referrerId = session.referrer_id;

            const userData = {
                telegram_id: ctx.from.id,
                full_name: session.fullName,
                birth_date: birthDate,
                photo_file_id: session.photo,
                token: token,
                is_premium: 0,
                referrer_id: referrerId,
                referrals_count: 0
            };

            await usersCollection.doc(targetId).set(userData);

            if (referrerId) {
                const refDocRef = usersCollection.doc(referrerId);
                await db.runTransaction(async (transaction) => {
                    const refDoc = await transaction.get(refDocRef);
                    if (refDoc.exists) {
                        const newCount = (refDoc.data().referrals_count || 0) + 1;
                        transaction.update(refDocRef, { referrals_count: newCount });
                    }
                });
            }

            await ctx.reply(
                `🎉 Вітаємо! Реєстрацію завершено!\n✨ Тепер ви можете користуватися всіма можливостями нашого графічного редактора.\n\n⚠️ Нагадуємо: створені зображення не мають юридичної сили та призначені виключно для розважальних цілей.`
            );

            delete userSessions[targetId]; 
            await sendMainMenu(ctx);

        } catch (e) {
            console.error('Помилка збереження даних у Firebase:', e);
            await ctx.reply('❌ Помилка збереження даних.');
        }
    }
});

// === ОБРАБОТКА КНОПОК МЕНЮ ===

bot.action('menu_profile', async (ctx) => {
    const targetId = String(ctx.from.id);
    try {
        const userDoc = await usersCollection.doc(targetId).get();
        if (!userDoc.exists) return ctx.reply('Спочатку пройдіть реєстрацію /start');
        
        const user = userDoc.data();
        const premiumStatus = user.is_premium ? "💎 Активна (Без вотермарок)" : "❌ Відсутня";
        const profileText = `👤 **Ваш Профіль:**\n\n` +
                            `📝 **ПІБ:** ${user.full_name}\n` +
                            `📅 **Дата народження:** ${user.birth_date}\n` +
                            `👑 **Підписка:** ${premiumStatus}\n` +
                            `🤝 **Запрошено друзів:** ${user.referrals_count}`;
        
        await ctx.replyWithPhoto(user.photo_file_id, {
            caption: profileText,
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([Markup.button.callback('⬅️ В меню', 'back_to_menu')])
        });
    } catch (e) {
        console.error(e);
    }
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('menu_download', async (ctx) => {
    const text = `📱 **Як додати наш сервіс на головний екран як додаток:**\n\n` +
                 `🤖 **Для Android (Google Chrome):**\n` +
                 `1. Відкрийте наш сайт у браузері Chrome.\n` +
                 `2. Натисніть на три крапки (меню) у верхньому правому кутку.\n` +
                 `3. Оберіть **"Додати на головний екран"** або **"Встановити додаток"**.\n\n` +
                 `🍏 **Для iOS / iPhone (Safari):**\n` +
                 `1. Відкрийте наш сайт у браузері Safari.\n` +
                 `2. Натисніть кнопку **"Поділитися"** (квадрат зі стрілкою вгору внизу екрана).\n` +
                 `3. Прокрутіть menu вниз і оберіть **"Додати на початковий екран"**.\n\n` +
                 `Після цього іконка з'явиться на робочому столі як звичайний додаток!`;

    await ctx.reply(text, Markup.inlineKeyboard([Markup.button.callback('⬅️ В меню', 'back_to_menu')]));
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('menu_token', async (ctx) => {
    const targetId = String(ctx.from.id);
    try {
        const userDoc = await usersCollection.doc(targetId).get();
        if (!userDoc.exists) return ctx.reply('Користувача не знайдено.');
        
        await ctx.reply(`🔑 Ваш унікальний код авторизації для додатка:\n\n\`${userDoc.data().token}\`\n\nСкопіюйте та вставте його при вході в додаток на сайті.`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([Markup.button.callback('⬅️ В меню', 'back_to_menu')])
        });
    } catch (e) {
        console.error(e);
    }
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('menu_referral', async (ctx) => {
    const targetId = String(ctx.from.id);
    try {
        const userDoc = await usersCollection.doc(targetId).get();
        const referralsCount = userDoc.exists ? (userDoc.data().referrals_count || 0) : 0;
        
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=${ctx.from.id}`;
        
        const text = `🤝 **Реферальна система**\n\n` +
                     `Запрошуйте друзів та отримуйте бонуси!\n` +
                     `👥 Кількість ваших рефералів: **${referralsCount}**\n\n` +
                     `🔗 Ваше реферальне посилання:\n${refLink}`;
                     
        await ctx.reply(text, Markup.inlineKeyboard([Markup.button.callback('⬅️ В меню', 'back_to_menu')]));
    } catch (e) {
        console.error(e);
    }
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('menu_change_data', async (ctx) => {
    const targetId = String(ctx.from.id);
    
    userSessions[targetId] = {
        step: 'photo',
        is_updating: true
    };
    
    await ctx.reply('🔄 Добре, давайте оновимо ваші дані. Надішліть **нове фото**:');
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('back_to_menu', async (ctx) => {
    await sendMainMenu(ctx);
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('menu_buy', async (ctx) => {
    const text = `💎 **Придбати Premium підписку**\n\n` +
                 `Оформлення підписки прибере всі червоні написи та обмеження у графічному редакторі.\n\n` +
                 `💵 Вартість: **150 грн** (або еквівалент в Telegram Stars чи криптовалюті)\n\n` +
                 `Оберіть зручний спосіб оплати:`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🌟 Оплатити Telegram Stars (35 Stars)', 'pay_stars')],
        [Markup.button.callback('🪙 Оплатити Криптовалютою (CryptoBot)', 'pay_crypto')],
        [Markup.button.callback('⬅️ Назад в меню', 'back_to_menu')]
    ]);

    await ctx.reply(text, keyboard);
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
});

bot.action('pay_stars', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
    
    await ctx.replyWithInvoice({
        title: 'Premium підписка',
        description: 'Доступ до графічного редактора без обмежень та вотермарок.',
        payload: `stars_premium_${ctx.from.id}`,
        provider_token: '', 
        currency: 'XTR',    
        prices: [{ label: 'Premium подписка', amount: 35 }] 
    });
});

bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
    const targetId = String(ctx.from.id);
    try {
        await usersCollection.doc(targetId).update({ is_premium: 1 });
        await ctx.reply('🎉 Дякуємо! Оплата Telegram Stars отримана. Ваш Premium аккаунт активовано!');
        await sendMainMenu(ctx);
    } catch (e) {
        console.error('Помилка оновлення преміуму после оплати Stars:', e);
    }
});

bot.action('pay_crypto', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) { console.log("Канапка застаріла"); }
    try {
        const response = await axios.post('https://pay.cryptobot.net/api/createInvoice', {
            asset: 'USDT',
            amount: '3.70', 
            description: 'Premium підписка для Графічного Редактора',
            payload: `crypto_premium_${ctx.from.id}`
        }, {
            headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN }
        });

        if (response.data && response.data.ok) {
            const invoice = response.data.result;
            const text = `🪙 Рахунок успішно створено!\n\n` +
                         `Для оплати перейдіть за посиланням в CryptoBot, здійсніть платіж, а потім поверніться сюди та натисніть "Перевірити оплату".`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('💸 Оплатити в Crypto Bot', invoice.pay_url)],
                [Markup.button.callback('🔄 Перевірити оплату', `check_crypto_${invoice.invoice_id}`)]
            ]);

            await ctx.reply(text, keyboard);
        } else {
            throw new Error('Ошибка вызова API CryptoBot');
        }
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
        await ctx.reply('❌ Помилка платіжної системи CryptoBot. Спробуйте пізніше.');
    }
});

bot.action(/^check_crypto_(\d+)$/, async (ctx) => {
    const invoiceId = ctx.match[1];
    const targetId = String(ctx.from.id);
    
    try {
        const response = await axios.get('https://pay.cryptobot.net/api/getInvoices', {
            params: { invoice_ids: invoiceId },
            headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN }
        });

        if (response.data && response.data.ok) {
            const invoices = response.data.result.items;
            const invoice = invoices.find(i => i.invoice_id == invoiceId);

            if (invoice && invoice.status === 'paid') {
                await usersCollection.doc(targetId).update({ is_premium: 1 });
                await ctx.reply('🎉 Чудово! Крипто-переказ підтверджено. Premium підписку активовано!');
                await sendMainMenu(ctx);
            } else {
                await ctx.answerCbQuery('❌ Рахунок ще не оплачено.', { show_alert: true });
            }
        } else {
            await ctx.answerCbQuery('⚠️ Помилка перевірки статусу.');
        }
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
        await ctx.answerCbQuery('⚠️ Помилка мережі при перевірці.');
    }
});

// === EXPRESS WEB API (ОНОВЛЕНИЙ І ЗБЕРЕЖЕНИЙ) ===
const app = express();

// 🛑 ДОДАНО ЦЕЙ БЛОК (CORS кусок для зв'язку ПК кента з твоїм сервером)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// 🔄 ОНОВЛЕНО ЦЕЙ МЕТОД (Тепер він вміє діставати пряме посилання на аватарку)
app.get('/user/:token', async (req, res) => {
    const token = req.params.token;

    try {
        const snapshot = await usersCollection.where('token', '==', token).limit(1).get();

        if (snapshot.empty) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userRawData = snapshot.docs[0].data();
        let photoUrl = "./photo.jpeg"; // Дефолтне фото
        
        // Перетворюємо Telegram file_id на робоче URL посилання
        if (userRawData.photo_file_id) {
            try {
                const fileLink = await bot.telegram.getFileLink(userRawData.photo_file_id);
                photoUrl = fileLink.href;
            } catch (err) {
                console.error("Не вдалося отримати лінк на фото з TG:", err);
            }
        }

        // Віддаємо збагачений об'єкт у React
        res.json({
            telegram_id: userRawData.telegram_id,
            full_name: userRawData.full_name,
            birth_date: userRawData.birth_date,
            photo: photoUrl,
            is_premium: userRawData.is_premium || 0
        });

    } catch (e) {
        console.error('API Error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.listen(PORT, () => {
    console.log(`API started on port ${PORT}`);
});

bot.launch();
console.log('Bot successfully started with Firebase cloud database!');