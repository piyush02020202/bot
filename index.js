require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits: P, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
const { Queue, queues, resolve, fmt } = require('./src/music');
const { startWeb, token } = require('./src/web');

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
