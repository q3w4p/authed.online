// Combined server - runs both Express backend and Discord bot
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();

// ============================================
// EXPRESS BACKEND SETUP
// ============================================

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS Configuration
app.use(cors({
    origin: [
        process.env.FRONTEND_URL,
        'https://authed.online',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());

// Configuration
const CONFIG = {
    CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    REDIRECT_URI: process.env.REDIRECT_URI,
    BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    GUILD_ID: process.env.GUILD_ID,
    VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID,
    WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    VERIFICATION_URL: process.env.FRONTEND_URL || 'https://authed.online'
};

// Validate configuration
function validateConfig() {
    const required = ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'BOT_TOKEN', 'GUILD_ID', 'VERIFIED_ROLE_ID'];
    const missing = required.filter(key => !CONFIG[key]);
    
    if (missing.length > 0) {
        console.error('❌ Missing required configuration:', missing.join(', '));
        console.error('Please check your .env file');
        process.exit(1);
    }
    
    console.log('✅ Configuration validated');
}

validateConfig();

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'authed.online backend running',
        timestamp: new Date().toISOString(),
        bot_status: client.isReady() ? 'Online' : 'Offline',
        endpoints: {
            auth: '/api/auth/discord'
        }
    });
});

// OAuth2 callback endpoint
app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        console.error('❌ No code provided in request');
        return res.status(400).json({ 
            success: false, 
            error: 'No authorization code provided' 
        });
    }

    try {
        console.log('🔄 Processing OAuth code...');

        // Step 1: Exchange code for access token
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: CONFIG.CLIENT_ID,
                client_secret: CONFIG.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: CONFIG.REDIRECT_URI
            })
        });

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok) {
            console.error('❌ Token exchange failed:', tokenData);
            return res.status(400).json({
                success: false,
                error: tokenData.error_description || tokenData.error || 'Failed to exchange authorization code'
            });
        }

        console.log('✅ Got access token');

        // Step 2: Fetch user data
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`
            }
        });

        const userData = await userResponse.json();

        if (!userResponse.ok) {
            console.error('❌ User fetch failed:', userData);
            return res.status(400).json({
                success: false,
                error: 'Failed to fetch Discord user data'
            });
        }

        console.log('✅ Fetched user data:', userData.username);

        // Build user object
        const user = {
            id: userData.id,
            username: userData.username,
            discriminator: userData.discriminator,
            email: userData.email,
            avatar: userData.avatar 
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` 
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(userData.discriminator) % 5}.png`,
            verified: userData.verified
        };

        // Step 3: Assign verified role (non-blocking)
        assignVerifiedRole(user.id).catch(error => {
            console.error('⚠️ Role assignment failed (non-fatal):', error.message);
        });

        // Step 4: Send to webhook logger (non-blocking)
        sendToLogger(user).catch(error => {
            console.error('⚠️ Webhook logging failed (non-fatal):', error.message);
        });

        // Return success response immediately
        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                email: user.email
            }
        });

    } catch (error) {
        console.error('❌ Auth error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Internal server error during authentication'
        });
    }
});

// Send to Discord webhook
async function sendToLogger(user) {
    if (!CONFIG.WEBHOOK_URL) {
        console.log('⚠️ No webhook URL configured, skipping logging');
        return;
    }

    const payload = {
        content: "📡 **User Verified & Logged**",
        embeds: [{
            title: "📊 User Verification Data",
            color: 5814783,
            fields: [
                { name: "👤 Discord ID", value: user.id, inline: true },
                { name: "📧 Email", value: user.email || "Not provided", inline: true },
                { name: "✅ Verified Status", value: user.verified ? "Yes" : "No", inline: true },
                { name: "📅 Timestamp", value: new Date().toLocaleString(), inline: false }
            ],
            thumbnail: { url: user.avatar },
            footer: { text: "authed.online OAuth Logger" }
        }]
    };

    try {
        const response = await fetch(CONFIG.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log('✅ Sent to webhook');
        } else {
            const errorText = await response.text();
            console.error('❌ Webhook failed:', response.status, errorText);
        }
    } catch (error) {
        console.error('❌ Webhook error:', error);
        throw error;
    }
}

// Assign verified role
async function assignVerifiedRole(userId) {
    try {
        console.log('🔄 Assigning role to user:', userId);

        const response = await fetch(
            `https://discord.com/api/v10/guilds/${CONFIG.GUILD_ID}/members/${userId}/roles/${CONFIG.VERIFIED_ROLE_ID}`,
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bot ${CONFIG.BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = { message: errorText };
            }

            console.error('❌ Failed to assign role:', errorData);
            
            if (response.status === 404) {
                throw new Error('User is not in the Discord server');
            } else if (response.status === 403) {
                throw new Error('Bot lacks permission to assign roles');
            } else if (response.status === 401) {
                throw new Error('Bot token is invalid');
            }
            
            throw new Error(`Failed to assign role: ${errorData.message || response.statusText}`);
        }

        console.log(`✅ Assigned verified role to user ${userId}`);
    } catch (error) {
        console.error('❌ Role assignment error:', error.message);
        throw error;
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ============================================
// DISCORD BOT SETUP
// ============================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

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
            default_member_permissions: PermissionFlagsBits.Administrator.toString()
        }
    ];

    if (CONFIG.GUILD_ID) {
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        await guild.commands.set(commands);
        console.log(`✅ Commands registered for guild: ${guild.name}`);
    } else {
        await client.application.commands.set(commands);
        console.log('✅ Commands registered globally');
    }
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'verify') {
        try {
            if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
                return await interaction.reply({
                    content: '❌ You need Administrator permissions to use this command.',
                    ephemeral: true
                });
            }

            const guildIconURL = interaction.guild.iconURL({ size: 256, extension: 'png' }) 
                || 'https://cdn.discordapp.com/embed/avatars/0.png';

            const embed = new EmbedBuilder()
                .setColor('#000000')
                .setTitle('Verify in /suffocated')
                .setDescription('Click the button below to verify your account and gain access to the server.')
                .setThumbnail(guildIconURL)
                .setFooter({ text: 'Verification powered by authed.online' })
                .setTimestamp();

            const button = new ButtonBuilder()
                .setLabel('Verify Account')
                .setStyle(ButtonStyle.Link)
                .setURL(CONFIG.VERIFICATION_URL)
                .setEmoji('🔗');

            const row = new ActionRowBuilder().addComponents(button);

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

// Bot error handling
client.on('error', (error) => {
    console.error('❌ Discord client error:', error);
});

// ============================================
// START EVERYTHING
// ============================================

// Start Express server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ================================');
    console.log('🚀 Server started successfully!');
    console.log('🚀 ================================');
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
    console.log('🚀 ================================\n');
});

// Start Discord bot
client.login(CONFIG.BOT_TOKEN)
    .then(() => console.log('🔄 Bot logging in...'))
    .catch((error) => {
        console.error('❌ Failed to login bot:', error);
    });

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        client.destroy();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('👋 SIGINT received, shutting down gracefully...');
    server.close(() => {
        client.destroy();
        process.exit(0);
    });
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});