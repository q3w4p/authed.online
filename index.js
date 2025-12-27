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
    VERIFICATION_URL: process.env.FRONTEND_URL || 'https://authed.online',
    AUTHORIZED_PULLER_ID: '1404732292412477531' // Only this user can run /pull
};

// In-memory database to store access tokens (for pulling users)
// In production, use a real database like MongoDB or PostgreSQL
const userTokens = new Map(); // userId -> { access_token, refresh_token }

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

        // Store access token for potential pulling later
        if (tokenData.access_token) {
            userTokens.set(user.id, {
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_at: Date.now() + (tokenData.expires_in * 1000)
            });
            console.log(`💾 Stored access token for user ${user.id}`);
        }

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

// Pull user into the server using their stored access token
async function pullUserToGuild(userId) {
    const tokenData = userTokens.get(userId);
    
    if (!tokenData) {
        throw new Error('No access token stored for this user');
    }

    // Check if token is expired
    if (Date.now() >= tokenData.expires_at) {
        throw new Error('Access token expired');
    }

    try {
        const response = await fetch(
            `https://discord.com/api/v10/guilds/${CONFIG.GUILD_ID}/members/${userId}`,
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bot ${CONFIG.BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    access_token: tokenData.access_token
                })
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

            throw new Error(errorData.message || `Failed to pull user: ${response.statusText}`);
        }

        // Check if user was already in server or just added
        if (response.status === 201) {
            console.log(`✅ Successfully pulled user ${userId} into server`);
            return 'added';
        } else if (response.status === 204) {
            console.log(`ℹ️ User ${userId} was already in server`);
            return 'already_member';
        }

        return 'success';
    } catch (error) {
        console.error(`❌ Failed to pull user ${userId}:`, error.message);
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
        },
        {
            name: 'pull',
            description: 'Pull all verified users into the server (AUTHORIZED ONLY)',
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

    // /verify command
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
                .setLabel('')
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

    // /pull command - Pull all verified users into the server
    if (interaction.commandName === 'pull') {
        try {
            // Check if user is authorized
            if (interaction.user.id !== CONFIG.AUTHORIZED_PULLER_ID) {
                return await interaction.reply({
                    content: '❌ You are not authorized to use this command.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            // Get all stored users with access tokens
            const storedUsers = Array.from(userTokens.keys());

            if (storedUsers.length === 0) {
                return await interaction.editReply({
                    content: '⚠️ No users have verified yet. There are no users to pull.'
                });
            }

            const results = {
                total: storedUsers.length,
                added: 0,
                already_member: 0,
                failed: 0,
                errors: []
            };

            // Pull each user
            for (const userId of storedUsers) {
                try {
                    const result = await pullUserToGuild(userId);
                    if (result === 'added') {
                        results.added++;
                    } else if (result === 'already_member') {
                        results.already_member++;
                    }
                } catch (error) {
                    results.failed++;
                    results.errors.push(`<@${userId}>: ${error.message}`);
                }
            }

            // Create response embed
            const resultEmbed = new EmbedBuilder()
                .setColor(results.failed === 0 ? '#00ff00' : '#ffaa00')
                .setTitle('🔄 Pull Operation Complete')
                .setDescription('Results of pulling verified users into the server:')
                .addFields(
                    { name: '📊 Total Users', value: results.total.toString(), inline: true },
                    { name: '✅ Successfully Added', value: results.added.toString(), inline: true },
                    { name: 'ℹ️ Already Members', value: results.already_member.toString(), inline: true },
                    { name: '❌ Failed', value: results.failed.toString(), inline: true }
                )
                .setTimestamp();

            if (results.errors.length > 0) {
                const errorList = results.errors.slice(0, 5).join('\n');
                const moreErrors = results.errors.length > 5 ? `\n...and ${results.errors.length - 5} more` : '';
                resultEmbed.addFields({
                    name: '⚠️ Errors',
                    value: errorList + moreErrors
                });
            }

            await interaction.editReply({
                embeds: [resultEmbed]
            });

            console.log(`✅ Pull command executed by ${interaction.user.tag}: ${results.added} added, ${results.failed} failed`);

        } catch (error) {
            console.error('❌ Error executing pull command:', error);
            await interaction.editReply({
                content: '❌ An error occurred while pulling users. Check console for details.'
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
    console.log(`👤 Authorized Puller: ${CONFIG.AUTHORIZED_PULLER_ID}`);
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