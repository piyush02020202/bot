require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
const PLAYER_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Music Player</title>\n<style>\nbody{margin:0;font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;display:flex;justify-content:center}\n.c{width:100%;max-width:560px;padding:20px}\n.card{background:#1f2937;border-radius:14px;padding:18px;margin-bottom:14px}\nimg{width:100%;border-radius:10px;margin-bottom:10px}\nbutton,input{font:inherit;border-radius:8px;border:0;padding:10px 14px}\nbutton{background:#5865f2;color:#fff;cursor:pointer;margin:4px 4px 0 0}button.d{background:#dc2626}\ninput{width:calc(100% - 100px);background:#374151;color:#fff}\nli{padding:6px 0;border-bottom:1px solid #374151;list-style:none}ul{padding:0;margin:0}\n#msg{color:#fca5a5;min-height:20px}\n</style></head><body><div class=\"c\">\n<h2>\ud83c\udfb5 Music Web Player</h2>\n<div class=\"card\" id=\"now\">Loading\u2026</div>\n<div class=\"card\">\n <button onclick=\"act('toggle')\">\u23ef Pause/Resume</button><button onclick=\"act('skip')\">\u23ed Skip</button>\n <button onclick=\"act('loop')\">\ud83d\udd01 Loop</button><button class=\"d\" onclick=\"act('stop')\">\u23f9 Stop</button>\n</div>\n<div class=\"card\"><input id=\"q\" placeholder=\"Song name or YouTube URL\"><button onclick=\"add()\">Add</button><div id=\"msg\"></div></div>\n<div class=\"card\"><b>Up next</b><ul id=\"list\"></ul></div>\n</div>\n<script>\nconst gid=location.pathname.split('/').pop(),t=new URLSearchParams(location.search).get('t');\nconst api=(p,o)=>fetch(`/api/${gid}/${p}?t=${t}`,o).then(r=>r.json());\nconst msg=m=>document.getElementById('msg').textContent=m||'';\nasync function act(a){const r=await api(a,{method:'POST'});msg(r.error);refresh()}\nasync function add(){const q=document.getElementById('q');const r=await api('play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q.value})});msg(r.error);q.value='';setTimeout(refresh,1500)}\nconst esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\nasync function refresh(){\n const s=await api('state');const n=document.getElementById('now');\n if(s.error){n.textContent=s.error;return}\n if(!s.active||!s.current){n.innerHTML='Nothing playing. Use <b>/play</b> in Discord to start.'}\n else{n.innerHTML=(s.current.thumb?`<img src=\"${esc(s.current.thumb)}\">`:'')+`<b>${esc(s.current.title)}</b><br>${s.paused?'\u23f8 Paused':'\u25b6 Playing'} \u2022 Loop: ${s.loop}`}\n document.getElementById('list').innerHTML=(s.queue||[]).map(x=>`<li>${esc(x.title)}</li>`).join('')||'<li>Empty</li>';\n}\nrefresh();setInterval(refresh,2500);\n</script></body></html>\n";
const MUSIC = (() => { const module = { exports: {} };
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus,
  VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const play = require('play-dl');

if (process.env.YT_COOKIE) play.setToken({ youtube: { cookie: process.env.YT_COOKIE } });

const queues = new Map();
const fmt = (s) => { s = Number(s) || 0; return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

async function resolve(query, by) {
  const mk = (v) => ({ title: v.title || 'Unknown', url: v.url, duration: v.durationInSec || 0, thumb: v.thumbnails?.[0]?.url, by });
  const type = play.yt_validate(query);
  if (type === 'playlist') {
    const pl = await play.playlist_info(query, { incomplete: true });
    return (await pl.all_videos()).slice(0, 50).map(mk);
  }
  if (type === 'video') return [mk((await play.video_info(query)).video_details)];
  const r = await play.search(query, { limit: 1, source: { youtube: 'video' } });
  return r.map(mk);
}

class Queue {
  constructor(guild, voiceChannel, textChannel) {
    this.guild = guild; this.textChannel = textChannel;
    this.songs = []; this.current = null; this.loop = 'off'; this.dead = false; this.skipFlag = false;
    this.player = createAudioPlayer();
    this.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
    this.connection.subscribe(this.player);
    this.player.on(AudioPlayerStatus.Idle, () => !this.dead && this.next());
    this.player.on('error', (e) => { console.error('player:', e.message); });
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000)]);
      } catch { this.destroy(); }
    });
    queues.set(guild.id, this);
  }
  enqueue(songs) {
    clearTimeout(this.idleTimer);
    this.songs.push(...songs);
    if (!this.current) this.next();
  }
  next() {
    if (this.loop === 'track' && this.current && !this.skipFlag) { /* replay same */ }
    else {
      if (this.loop === 'queue' && this.current) this.songs.push(this.current);
      this.current = this.songs.shift() || null;
    }
    this.skipFlag = false;
    if (!this.current) { this.idleTimer = setTimeout(() => this.destroy(), 120000); return; }
    this.playCurrent();
  }
  async playCurrent() {
    const song = this.current;
    try {
      const s = await play.stream(song.url, { quality: 2 });
      this.player.play(createAudioResource(s.stream, { inputType: s.type }));
      this.textChannel?.send(this.panel()).catch(() => {});
    } catch (e) {
      this.textChannel?.send(`❌ Couldn't play **${song.title}**: ${e.message}`).catch(() => {});
      this.skipFlag = true; this.next();
    }
  }
  toggle() { this.player.state.status === AudioPlayerStatus.Paused ? this.player.unpause() : this.player.pause(); }
  skip() { this.skipFlag = true; this.player.stop(); if (!this.current) this.next(); }
  cycleLoop() { this.loop = { off: 'track', track: 'queue', queue: 'off' }[this.loop]; return this.loop; }
  destroy() {
    if (this.dead) return; this.dead = true; clearTimeout(this.idleTimer);
    this.songs = []; this.current = null;
    try { this.player.stop(true); this.connection.destroy(); } catch {}
    queues.delete(this.guild.id);
  }
  state() {
    return {
      paused: this.player.state.status === AudioPlayerStatus.Paused, loop: this.loop,
      current: this.current, queue: this.songs.slice(0, 25),
    };
  }
  panel() {
    const s = this.current;
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle(s ? '🎶 Now playing' : '💤 Nothing playing')
      .setDescription(s ? `**[${s.title}](${s.url})**\nDuration: ${fmt(s.duration)} • Requested by ${s.by}` : 'Use `/play` to add a song.')
      .setFooter({ text: `Loop: ${this.loop} • Up next: ${this.songs.length}` });
    if (s?.thumb) embed.setThumbnail(s.thumb);
    const b = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`music:${id}`).setLabel(label).setStyle(style);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(
      b('toggle', '⏯ Pause/Resume'), b('skip', '⏭ Skip'), b('loop', '🔁 Loop'), b('stop', '⏹ Stop', ButtonStyle.Danger)
    )] };
  }
}

module.exports = { Queue, queues, resolve, fmt };

return module.exports; })();
const WEB = (() => { const module = { exports: {} };
const express = require('express');
const crypto = require('crypto');
const { queues, resolve } = MUSIC;

const SECRET = process.env.SESSION_SECRET || 'change-me';
const token = (gid) => crypto.createHmac('sha256', SECRET).update(gid).digest('hex').slice(0, 24);

function startWeb() {
  const app = express();
  app.use(express.json());
  app.get('/', (_, r) => r.send('Bot is running ✅'));
  app.get('/health', (_, r) => r.send('ok'));
    app.get('/player/:gid', (_, r) => r.type('html').send(PLAYER_HTML));

  app.use('/api/:gid', (req, res, next) => {
    if (req.query.t !== token(req.params.gid)) return res.status(403).json({ error: 'Invalid link' });
    next();
  });
  app.get('/api/:gid/state', (req, res) => {
    const q = queues.get(req.params.gid);
    res.json(q ? { active: true, ...q.state() } : { active: false });
  });
  app.post('/api/:gid/:action', async (req, res) => {
    const q = queues.get(req.params.gid);
    if (!q) return res.status(404).json({ error: 'Bot is not in a voice channel. Use /play in Discord first.' });
    try {
      const a = req.params.action;
      if (a === 'toggle') q.toggle();
      else if (a === 'skip') q.skip();
      else if (a === 'loop') q.cycleLoop();
      else if (a === 'stop') q.destroy();
      else if (a === 'play') q.enqueue(await resolve(String(req.body.query || ''), 'Web player'));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Web listening on', port));

  // keep free hosts (e.g. Render) awake
  const self = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => fetch(self + '/health').catch(() => {}), 10 * 60 * 1000);
}

module.exports = { startWeb, token };

return module.exports; })();
const { Queue, queues, resolve, fmt } = MUSIC;
const { startWeb, token } = WEB;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });
const Guild = mongoose.model('Guild', new mongoose.Schema({ _id: String, welcomeChannel: String, welcomeMessage: String }));

const fill = (t, m) => t.replaceAll('{user}', `<@${m.id}>`).replaceAll('{username}', m.user.username)
  .replaceAll('{server}', m.guild.name).replaceAll('{count}', m.guild.memberCount);
const sendWelcome = async (m) => {
  const cfg = await Guild.findById(m.guild.id);
  const ch = cfg?.welcomeChannel && m.guild.channels.cache.get(cfg.welcomeChannel);
  if (!ch) return false;
  await ch.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setThumbnail(m.user.displayAvatarURL()).setDescription(fill(cfg.welcomeMessage, m))] });
  return true;
};
const btnRow = (...b) => new ActionRowBuilder().addComponents(b);
const needQueue = (i) => queues.get(i.guildId) || (i.reply({ content: 'Nothing is playing.', ephemeral: true }), null);

const mod = (name, desc, perm, fn, extra = (b) => b) => ({
  data: extra(new SlashCommandBuilder().setName(name).setDescription(desc).setDefaultMemberPermissions(perm)), run: fn });
const user = (b) => b.addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason'));

const commands = [
  { data: new SlashCommandBuilder().setName('welcome').setDescription('Custom welcome message').setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Set channel and message')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Variables: {user} {username} {server} {count}').setRequired(true)))
      .addSubcommand((s) => s.setName('test').setDescription('Preview the welcome message'))
      .addSubcommand((s) => s.setName('off').setDescription('Disable welcome messages')),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'set') {
        await Guild.findByIdAndUpdate(i.guildId, { welcomeChannel: i.options.getChannel('channel').id, welcomeMessage: i.options.getString('message') }, { upsert: true });
        return i.reply({ content: '✅ Welcome message saved. Try `/welcome test`.', ephemeral: true });
      }
      if (sub === 'off') { await Guild.findByIdAndDelete(i.guildId); return i.reply({ content: '✅ Disabled.', ephemeral: true }); }
      const ok = await sendWelcome(i.member);
      i.reply({ content: ok ? '✅ Sent.' : 'Set it up first with `/welcome set`.', ephemeral: true });
    } },

  { data: new SlashCommandBuilder().setName('verify').setDescription('Post a verification button').setDefaultMemberPermissions(P.ManageGuild)
      .addRoleOption((o) => o.setName('role').setDescription('Role given after verifying').setRequired(true))
      .addStringOption((o) => o.setName('text').setDescription('Panel text')),
    async run(i) {
      const role = i.options.getRole('role');
      await i.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('✅ Verification')
        .setDescription(i.options.getString('text') || 'Click the button below to verify and access the server.')],
        components: [btnRow(new ButtonBuilder().setCustomId(`verify:${role.id}`).setLabel('Verify').setStyle(ButtonStyle.Success))] });
      i.reply({ content: 'Posted.', ephemeral: true });
    } },

  { data: (() => { const b = new SlashCommandBuilder().setName('rolepanel').setDescription('Self-assign roles panel').setDefaultMemberPermissions(P.ManageRoles)
      .addRoleOption((o) => o.setName('role1').setDescription('Role').setRequired(true));
      for (let n = 2; n <= 5; n++) b.addRoleOption((o) => o.setName(`role${n}`).setDescription('Role'));
      return b.addStringOption((o) => o.setName('title').setDescription('Panel title')); })(),
    async run(i) {
      const roles = [1, 2, 3, 4, 5].map((n) => i.options.getRole(`role${n}`)).filter(Boolean);
      await i.channel.send({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(i.options.getString('title') || 'Pick your roles')
        .setDescription('Click a button to get or remove a role.')],
        components: [btnRow(...roles.map((r) => new ButtonBuilder().setCustomId(`role:${r.id}`).setLabel(r.name).setStyle(ButtonStyle.Primary)))] });
      i.reply({ content: 'Posted.', ephemeral: true });
    } },

  mod('kick', 'Kick a member', P.KickMembers, async (i) => {
    const m = i.options.getMember('user');
    if (!m?.kickable) return i.reply({ content: "I can't kick that user.", ephemeral: true });
    await m.kick(i.options.getString('reason') || undefined); i.reply(`👢 Kicked **${m.user.tag}**`);
  }, user),
  mod('ban', 'Ban a member', P.BanMembers, async (i) => {
    const m = i.options.getMember('user');
    if (!m?.bannable) return i.reply({ content: "I can't ban that user.", ephemeral: true });
    await m.ban({ reason: i.options.getString('reason') || undefined }); i.reply(`🔨 Banned **${m.user.tag}**`);
  }, user),
  mod('timeout', 'Timeout a member', P.ModerateMembers, async (i) => {
    const m = i.options.getMember('user');
    if (!m?.moderatable) return i.reply({ content: "I can't timeout that user.", ephemeral: true });
    await m.timeout(i.options.getInteger('minutes') * 60000, i.options.getString('reason') || undefined);
    i.reply(`⏳ Timed out **${m.user.tag}** for ${i.options.getInteger('minutes')} min`);
  }, (b) => user(b).addIntegerOption((o) => o.setName('minutes').setDescription('Minutes').setMinValue(1).setMaxValue(40320).setRequired(true))),
  mod('purge', 'Delete recent messages', P.ManageMessages, async (i) => {
    const d = await i.channel.bulkDelete(i.options.getInteger('amount'), true);
    i.reply({ content: `🧹 Deleted ${d.size} messages.`, ephemeral: true });
  }, (b) => b.addIntegerOption((o) => o.setName('amount').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true))),

  { data: new SlashCommandBuilder().setName('play').setDescription('Play a song or playlist')
      .addStringOption((o) => o.setName('query').setDescription('Name or YouTube URL').setRequired(true)),
    async run(i) {
      const vc = i.member.voice.channel;
      if (!vc) return i.reply({ content: 'Join a voice channel first.', ephemeral: true });
      await i.deferReply();
      try {
        const songs = await resolve(i.options.getString('query'), i.user.username);
        if (!songs.length) return i.editReply('No results.');
        const q = queues.get(i.guildId) || new Queue(i.guild, vc, i.channel);
        q.enqueue(songs);
        i.editReply(songs.length > 1 ? `➕ Added **${songs.length}** songs.` : `➕ Added **${songs[0].title}**`);
      } catch (e) { i.editReply(`❌ ${e.message}`); }
    } },
  { data: new SlashCommandBuilder().setName('skip').setDescription('Skip song'), run(i) { const q = needQueue(i); if (q) { q.skip(); i.reply('⏭ Skipped'); } } },
  { data: new SlashCommandBuilder().setName('stop').setDescription('Stop and leave'), run(i) { const q = needQueue(i); if (q) { q.destroy(); i.reply('⏹ Stopped'); } } },
  { data: new SlashCommandBuilder().setName('pause').setDescription('Pause/resume'), run(i) { const q = needQueue(i); if (q) { q.toggle(); i.reply('⏯ Toggled'); } } },
  { data: new SlashCommandBuilder().setName('loop').setDescription('Cycle loop: off/track/queue'), run(i) { const q = needQueue(i); if (q) i.reply(`🔁 Loop: **${q.cycleLoop()}**`); } },
  { data: new SlashCommandBuilder().setName('queue').setDescription('Show queue'), run(i) {
      const q = needQueue(i); if (!q) return;
      const l = q.songs.slice(0, 10).map((s, n) => `${n + 1}. ${s.title} (${fmt(s.duration)})`).join('\n') || 'Empty';
      i.reply(`**Now:** ${q.current?.title || '-'}\n${l}`); } },
  { data: new SlashCommandBuilder().setName('panel').setDescription('Show the music control panel'), run(i) { const q = needQueue(i); if (q) i.reply(q.panel()); } },
  { data: new SlashCommandBuilder().setName('weblink').setDescription('Get your private web player link'),
    run(i) { i.reply({ content: `🌐 ${process.env.BASE_URL}/player/${i.guildId}?t=${token(i.guildId)}\nKeep this link private, anyone with it can control the music.`, ephemeral: true }); } },
];
const byName = new Map(commands.map((c) => [c.data.name, c]));

client.once('ready', async () => {
  await client.application.commands.set(commands.map((c) => c.data.toJSON()));
  console.log(`Logged in as ${client.user.tag}`);
});
client.on('guildMemberAdd', (m) => sendWelcome(m).catch(console.error));

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) return await byName.get(i.commandName)?.run(i);
    if (!i.isButton()) return;
    const [kind, arg] = i.customId.split(':');
    if (kind === 'verify' || kind === 'role') {
      const role = i.guild.roles.cache.get(arg);
      if (!role) return i.reply({ content: 'Role no longer exists.', ephemeral: true });
      const has = i.member.roles.cache.has(role.id);
      if (kind === 'verify' && has) return i.reply({ content: 'You are already verified ✅', ephemeral: true });
      await (has ? i.member.roles.remove(role) : i.member.roles.add(role));
      return i.reply({ content: kind === 'verify' ? '✅ Verified!' : `${has ? 'Removed' : 'Added'} **${role.name}**`, ephemeral: true });
    }
    if (kind === 'music') {
      const q = queues.get(i.guildId);
      if (!q) return i.update({ content: 'Nothing is playing.', embeds: [], components: [] });
      if (!i.member.voice.channelId || i.member.voice.channelId !== i.guild.members.me.voice.channelId)
        return i.reply({ content: 'Join my voice channel to use the panel.', ephemeral: true });
      if (arg === 'stop') { q.destroy(); return i.update({ content: '⏹ Stopped', embeds: [], components: [] }); }
      if (arg === 'toggle') q.toggle();
      if (arg === 'loop') q.cycleLoop();
      if (arg === 'skip') { q.skip(); return i.reply({ content: '⏭ Skipped', ephemeral: true }); }
      return i.update(q.panel());
    }
  } catch (e) {
    console.error(e);
    const r = { content: '⚠️ Something went wrong. Check my permissions/role position.', ephemeral: true };
    (i.replied || i.deferred) ? i.followUp(r).catch(() => {}) : i.reply(r).catch(() => {});
  }
});

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  startWeb();
  await client.login(process.env.DISCORD_TOKEN);
})();
