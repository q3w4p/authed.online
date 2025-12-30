const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS Configuration - Allow requests from authed.online
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

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Configuration
const CONFIG = {
    CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    REDIRECT_URI: process.env.REDIRECT_URI,
    BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    GUILD_ID: process.env.GUILD_ID,
    VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID
    // Removed WEBHOOK_URL - frontend handles logging
};

// Validate configuration on startup
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
        console.log('🔗 Redirect URI:', CONFIG.REDIRECT_URI);

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

        // NOTE: Webhook logging is handled by the frontend with enhanced data
        // No duplicate webhook call here

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

// Start server
app.listen(PORT, () => {
    console.log('\n🚀 ================================');
    console.log('🚀 Server started successfully!');
    console.log('🚀 ================================');
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
    
    if (process.env.CODESPACE_NAME) {
        const codespaceUrl = `https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
        console.log(`🔧 Codespace URL: ${codespaceUrl}`);
        console.log(`⚠️  Make sure to update BACKEND_URL in your HTML files to: ${codespaceUrl}`);
    }
    
    console.log('🚀 ================================\n');
    console.log('ℹ️  Note: Webhook logging is handled by frontend with enhanced IP/VPN data');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('👋 SIGINT received, shutting down gracefully...');
    process.exit(0);
});