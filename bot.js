const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// Configuration
const CONFIG = {
    BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    VERIFICATION_URL: 'https://authed.online', // Your verification website URL
    GUILD_ID: process.env.GUILD_ID
};

// Bot ready event
client.once('ready', async () => {
    console.log('✅ Bot is online!');
    console.log(`📝 Logged in as ${client.user.tag}`);
    
    // Register slash commands
    try {
        await registerCommands();
        console.log('✅ Slash commands registered successfully');
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }
});

// Register slash commands
async function registerCommands() {
    const commands = [
        {
            name: 'verify',
            description: 'Send the verification embed',
            default_member_permissions: PermissionFlagsBits.Administrator.toString() // Admin only
        }
    ];

    // Register globally or for specific guild
    if (CONFIG.GUILD_ID) {
        // Register for specific guild (instant update)
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        await guild.commands.set(commands);
        console.log(`✅ Commands registered for guild: ${guild.name}`);
    } else {
        // Register globally (takes up to 1 hour)
        await client.application.commands.set(commands);
        console.log('✅ Commands registered globally');
    }
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // /verify command
    if (interaction.commandName === 'verify') {
        try {
            // Double-check permissions
            if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
                return await interaction.reply({
                    content: '❌ You need Administrator permissions to use this command.',
                    ephemeral: true
                });
            }

            // Get guild icon
            const guildIconURL = interaction.guild.iconURL({ size: 256, extension: 'png' }) 
                || 'https://cdn.discordapp.com/embed/avatars/0.png';

            // Create embed
            const embed = new EmbedBuilder()
                .setColor('#000000') // Black color
                .setTitle('Verify in /suffocated')
                .setDescription('Click the button below to verify your account and gain access to the server.')
                .setThumbnail(guildIconURL) // Guild icon in top right
                .setFooter({ text: 'Verification powered by authed.online' })
                .setTimestamp();

            // Create button with link
            const button = new ButtonBuilder()
                .setLabel('Verify Account')
                .setStyle(ButtonStyle.Link)
                .setURL(CONFIG.VERIFICATION_URL)
                .setEmoji('🔗'); // Link emoji

            const row = new ActionRowBuilder().addComponents(button);

            // Send the embed
            await interaction.reply({
                embeds: [embed],
                components: [row]
            });

            console.log(`✅ Verification embed sent by ${interaction.user.tag} in #${interaction.channel.name}`);

        } catch (error) {
            console.error('❌ Error sending verification embed:', error);
            await interaction.reply({
                content: '❌ Failed to send verification embed. Please try again.',
                ephemeral: true
            });
        }
    }
});

// Error handling
client.on('error', (error) => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Login
client.login(CONFIG.BOT_TOKEN)
    .then(() => console.log('🔄 Logging in...'))
    .catch((error) => {
        console.error('❌ Failed to login:', error);
        process.exit(1);
    });