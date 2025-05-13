const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection, StreamType } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('ffmpeg-static');
const playdl = require('play-dl');
const { setTimeout } = require('timers/promises');
const { get } = require('https');
const { spawn } = require('child_process');

const TOKEN = process.env.BOT_TOKEN;
const YT_COOKIE = process.env.YT_COOKIE;

process.env.FFMPEG_PATH = ffmpeg;
console.log('FFMPEG_PATH:', ffmpeg);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

let queue = [];
let current = null;
let player = createAudioPlayer();
player.on('error', error => {
    console.error(`Ошибка плеера: ${error.message}`);
});
player.on(AudioPlayerStatus.Idle, () => {
    playNext(textChannel?.guild?.id);
});
let textChannel = null;
let loopMode = 'off'; // off, track, queue
let lastEmbedMsg = null;

function getControlRow(isLoopTrack, isLoopQueue) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('resume').setEmoji('▶️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('loop_track').setEmoji(isLoopTrack ? '🔂' : '🔁').setStyle(isLoopTrack ? ButtonStyle.Success : ButtonStyle.Secondary)
        );
}

function resetPlayerState(guildId) {
    queue = [];
    current = null;
    player.stop();
    getVoiceConnection(guildId)?.destroy();
    if (lastEmbedMsg) {
        lastEmbedMsg.delete().catch(() => {});
        lastEmbedMsg = null;
    }
}

async function playNext(guildId) {
    if (!queue.length && loopMode !== 'track') {
        current = null;
        getVoiceConnection(guildId)?.destroy();
        if (lastEmbedMsg) {
            lastEmbedMsg.delete().catch(() => {});
            lastEmbedMsg = null;
        }
        if (textChannel) textChannel.send('Очередь пуста, отключаюсь.');
        return;
    }
    if (loopMode === 'track' && current) {
        queue.unshift(current);
    } else if (loopMode === 'queue' && current) {
        queue.push(current);
    }
    current = queue.shift();
    let stream, info, resource;
    try {
        console.log('playNext: current.url =', current.url);
        if (!current.url || typeof current.url !== 'string' || !/^https?:\/\//.test(current.url)) {
            throw new Error('Некорректная ссылка для проигрывания: ' + current.url);
        }

        // YouTube и YouTube Music через ytdl-core с поддержкой cookies
        if (/^https?:\/\/(www\.)?(youtube\.com|music\.youtube\.com)\/watch\?v=/.test(current.url) || /^https?:\/\/youtu\.be\//.test(current.url)) {
            let ytdlOptions = { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 };
            if (YT_COOKIE) {
                ytdlOptions.requestOptions = {
                    headers: {
                        cookie: YT_COOKIE
                    }
                };
            }
            stream = ytdl(current.url, ytdlOptions);
            info = { video_details: { title: current.title, thumbnails: [{ url: '' }], durationInSec: 0, channel: { name: '' } } };
        } else if (current.url.endsWith('.mp3')) {
            stream = await new Promise((resolve) => {
                get(current.url, (res) => resolve(res));
            });
            info = { video_details: { title: current.title, thumbnails: [{ url: '' }], durationInSec: 0, channel: { name: '' } } };
        } else {
            let playdlStream = await playdl.stream(current.url, { quality: 2, highWaterMark: 1 << 25 }); // 32MB
            info = await playdl.video_basic_info(current.url);
            stream = playdlStream?.stream ?? playdlStream;
            if (!stream) {
                console.error('⛔ Не удалось получить поток через play-dl');
                if (textChannel) textChannel.send('Ошибка: не удалось получить поток через play-dl.');
                return;
            }
        }

        if (!stream || typeof stream.on !== 'function' || typeof stream.pipe !== 'function') {
            console.error('⛔ Поток не является readable-стримом');
            if (textChannel) textChannel.send('Ошибка: поток не является readable-стримом.');
            return;
        }

        const ffmpegProcess = spawn(ffmpeg, [
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1'
        ], {
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true
        });

        stream.once('error', err => {
            console.error('❌ Ошибка в потоке:', err);
        });
        stream.pipe(ffmpegProcess.stdin).on('error', err => {
            console.error('❌ Ошибка при pipe в ffmpegProcess.stdin:', err);
        });

        resource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        player.stop();
        player.play(resource);
    } catch (e) {
        console.error('Ошибка при получении аудиопотока:', e);
        if (textChannel) textChannel.send('Ошибка при попытке воспроизвести трек: ' + (e.message || e));
        playNext(guildId);
        return;
    }

    if (textChannel) {
        const embed = new EmbedBuilder()
            .setTitle('🎶 Сейчас играет')
            .setDescription(`[${current.title}](${current.url})`)
            .setThumbnail(
                info.video_details?.thumbnails?.[0]?.url && info.video_details?.thumbnails?.[0]?.url.startsWith('http')
                    ? info.video_details.thumbnails[0].url
                    : undefined
            )
            .addFields(
                { name: 'Автор', value: info.video_details?.channel?.name || info.user?.name || '-', inline: true },
                { name: 'Длительность', value: info.video_details?.durationRaw || info.durationRaw || '-', inline: true }
            )
            .setColor(0x1DB954)
            .setFooter({ text: 'Музыкальный бот', iconURL: client.user.displayAvatarURL() });
        if (lastEmbedMsg) await lastEmbedMsg.delete().catch(() => {});
        lastEmbedMsg = await textChannel.send({ embeds: [embed], components: [getControlRow(loopMode === 'track', loopMode === 'queue')] });
    }
}

function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    textChannel = message.channel;

    // !play <url or search>
    if (message.content.startsWith('!play ')) {
        let query = message.content.slice(6).trim();
        let url = query;
        let info;
        if (!/^https?:\/\//.test(query)) {
            let results = await playdl.search(query, { limit: 1 });
            if (!results.length) return message.reply('Ничего не найдено.');
            url = results[0].url;
            info = results[0];
        } else {
            if (playdl.yt_validate(url) === 'video') {
                info = (await playdl.video_basic_info(url)).video_details;
            } else if (url.endsWith('.mp3')) {
                info = { title: url.split('/').pop(), url };
            } else {
                info = { title: url, url };
            }
        }
        queue.push({ url, title: info.title, artist: info.channel?.name || info.user?.name || '' });

        let connection = getVoiceConnection(message.guild.id);
        if (!current) {
            if (!message.member.voice.channel) {
                message.reply('Сначала зайдите в голосовой канал!');
                return;
            }
            if (!connection) {
                const conn = joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                    selfMute: false,
                    selfDeaf: false
                });
                conn.subscribe(player);
            }
            playNext(message.guild.id);
        } else {
            message.reply(`Добавлено в очередь: **${info.title}**`);
        }
    }

    // !search <запрос>
    if (message.content.startsWith('!search ')) {
        let query = message.content.slice(8).trim();
        let results = await playdl.search(query, { limit: 5 });
        if (!results.length) return message.reply('Ничего не найдено.');
        let embed = new EmbedBuilder()
            .setTitle('Результаты поиска')
            .setDescription(results.map((r, i) => `**${i + 1}.** [${r.title}](${r.url})`).join('\n'))
            .setColor(0x7289DA);
        let row = new ActionRowBuilder();
        results.forEach((r, i) => {
            row.addComponents(new ButtonBuilder().setCustomId(`pick_${i}`).setLabel(`${i + 1}`).setStyle(ButtonStyle.Primary));
        });
        let msg = await message.reply({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && i.customId.startsWith('pick_');
        msg.awaitMessageComponent({ filter, time: 15000 }).then(async i => {
            let idx = Number(i.customId.split('_')[1]);
            let picked = results[idx];
            queue.push({ url: picked.url, title: picked.title, artist: picked.channel?.name || '' });
            await i.reply({ content: `Добавлено в очередь: **${picked.title}**`, ephemeral: true });
            if (!current) {
                if (!message.member.voice.channel) {
                    message.reply('Сначала зайдите в голосовой канал!');
                    return;
                }
                joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator
                }).subscribe(player);
                playNext(message.guild.id);
            }
        }).catch(() => {});
    }

    // !queue
    if (message.content === '!queue') {
        if (queue.length === 0) {
            message.reply('Очередь пуста.');
        } else {
            let embed = new EmbedBuilder()
                .setTitle('Очередь')
                .setDescription(queue.map((t, i) => `${i + 1}. [${t.title}](${t.url})`).join('\n'))
                .setColor(0x5865F2);
            message.reply({ embeds: [embed] });
        }
    }

    // !nowplaying
    if (message.content === '!nowplaying') {
        if (!current) return message.reply('Сейчас ничего не играет.');
        let embed = new EmbedBuilder()
            .setTitle('Сейчас играет')
            .setDescription(`[${current.title}](${current.url})`)
            .setColor(0x1DB954);
        message.reply({ embeds: [embed] });
    }

    // !shuffle
    if (message.content === '!shuffle') {
        queue = queue.sort(() => Math.random() - 0.5);
        message.reply('Очередь перемешана.');
    }

    // !loop <off|track|queue>
    if (message.content.startsWith('!loop')) {
        let arg = message.content.split(' ')[1];
        if (['off', 'track', 'queue'].includes(arg)) {
            loopMode = arg;
            message.reply(`Режим повтора: **${arg}**`);
        } else {
            message.reply('Используйте: !loop off | track | queue');
        }
    }

    // !lyrics
    if (message.content === '!lyrics') {
        if (!current) return message.reply('Сейчас ничего не играет.');
        let lyrics = await getLyrics(current.title + ' ' + (current.artist || ''));
        if (!lyrics) return message.reply('Текст не найден.');
        let chunks = lyrics.match(/[\s\S]{1,1900}/g);
        for (let chunk of chunks) {
            await message.reply(chunk);
        }
    }

    // !stop (добавь команду для ручного сброса)
    if (message.content === '!stop') {
        resetPlayerState(message.guild.id);
        message.reply('Бот остановлен и очередь сброшена.');
    }

    // !testsound — тестовый сигнал
    if (message.content === '!testsound') {
        if (!message.member.voice.channel) {
            message.reply('Сначала зайдите в голосовой канал!');
            return;
        }
        let connection = getVoiceConnection(message.guild.id);
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: message.member.voice.channel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfMute: false,
                selfDeaf: false
            });
            connection.subscribe(player);
            console.log("🔊 Бот подключен к голосовому каналу и подписан на плеер (тест).");
        }
        // Генерируем 2 секунды синусоиды 440 Гц через ffmpeg
        const { spawn } = require('child_process');
        const ffmpegProcess = spawn(ffmpeg, [
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=2',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1'
        ]);
        const resource = createAudioResource(ffmpegProcess.stdout, {
            inputType: StreamType.Raw
        });
        player.play(resource);
        message.reply('▶️ Тестовый звук воспроизводится в голосовом канале!');
        return;
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    switch (interaction.customId) {
        case 'pause':
            player.pause();
            await interaction.reply({ content: 'Пауза.', flags: 64 });
            break;
        case 'resume':
            player.unpause();
            await interaction.reply({ content: 'Продолжаем.', flags: 64 });
            break;
        case 'skip':
            player.stop();
            await interaction.reply({ content: 'Пропущено.', flags: 64 });
            break;
        case 'stop':
            resetPlayerState(interaction.guildId);
            await interaction.reply({ content: 'Остановлено и отключено.', flags: 64 });
            break;
        case 'loop_track':
            loopMode = loopMode === 'track' ? 'off' : 'track';
            await interaction.reply({ content: `Режим повтора трека: ${loopMode === 'track' ? 'включён' : 'выключен'}`, flags: 64 });
            break;
        case 'loop_queue':
            loopMode = loopMode === 'queue' ? 'off' : 'queue';
            await interaction.reply({ content: `Режим повтора очереди: ${loopMode === 'queue' ? 'включён' : 'выключен'}`, flags: 64 });
            break;
        case 'shuffle':
            queue = queue.sort(() => Math.random() - 0.5);
            await interaction.reply({ content: 'Очередь перемешана.', ephemeral: true });
            break;
    }
    if (lastEmbedMsg && lastEmbedMsg.edit) {
        await lastEmbedMsg.edit({ components: [getControlRow(loopMode === 'track', loopMode === 'queue')] });
    }
});

// Автоотключение при пустом голосовом канале
client.on('voiceStateUpdate', (oldState, newState) => {
    let connection = getVoiceConnection(oldState.guild.id);
    if (!connection) return;
    let channel = oldState.guild.channels.cache.get(connection.joinConfig.channelId);
    if (channel && channel.members.filter(m => !m.user.bot).size === 0) {
        connection.destroy();
        if (textChannel) textChannel.send('Голосовой канал пуст, отключаюсь.');
    }
});

// Получение текста песни (lyrics)
async function getLyrics(query) {
    try {
        const res = await fetch(`https://some-random-api.ml/lyrics?title=${encodeURIComponent(query)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.lyrics;
    } catch {
        return null;
    }
}

client.once('ready', () => {
    console.log(`Бот запущен как ${client.user.tag}`);
});

client.login(TOKEN);
