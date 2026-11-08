// One-time interactive login for the personal Telegram account.
// Run locally with: npm install && npm run login:telegram
// The resulting session string is a full login credential. Never commit or share it.
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  let client;

  try {
    const apiIdInput = process.env.TELEGRAM_API_ID || await rl.question('Telegram API ID: ');
    const apiHash = process.env.TELEGRAM_API_HASH || await rl.question('Telegram API HASH: ');
    const apiId = Number(apiIdInput);

    if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash.trim()) {
      throw new Error('API ID or API HASH is invalid.');
    }

    client = new TelegramClient(new StringSession(''), apiId, apiHash.trim(), {
      connectionRetries: 5
    });

    console.log('A login code will be sent by Telegram (usually to your logged-in Telegram app).');
    await client.start({
      phoneNumber: () => rl.question('Phone number (international format): '),
      password: () => rl.question('Telegram 2-step verification password (if enabled): '),
      phoneCode: (_isCodeViaApp, info) => rl.question(`Telegram login code [${info?.type || 'code'}]: `),
      emailAddress: () => rl.question('Login email (if requested): '),
      emailVerification: () => rl.question('Email verification code (if requested): '),
      onError: (error) => console.error('Telegram login error:', error?.message || error)
    });

    const me = await client.getMe();
    const session = client.session.save();
    console.log('\nLogin successful for:', me.username || me.firstName || 'Telegram account');
    console.log('\n========== COPY THIS SESSION INTO GITHUB SECRET TELEGRAM_SESSION ==========');
    console.log(session);
    console.log('============================== END SESSION ==============================\n');
    console.log('Do not send this session to anyone or commit it to GitHub.');
  } finally {
    if (client) {
      try { await client.disconnect(); } catch {}
    }
    rl.close();
  }
}

main().catch((error) => {
  console.error('Login failed:', error?.message || error);
  process.exitCode = 1;
});
