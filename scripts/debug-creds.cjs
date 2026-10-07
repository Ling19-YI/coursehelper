const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const f = path.join(app.getPath('userData'), 'credentials.enc');
  console.log('file:', f, fs.existsSync(f));
  const buf = fs.readFileSync(f);
  console.log('encAvailable:', safeStorage.isEncryptionAvailable(), 'len:', buf.length);
  try {
    const s = safeStorage.decryptString(buf);
    console.log('decrypted:', JSON.stringify(s));
  } catch (e) {
    console.log('decrypt error:', e.message);
    console.log('as utf8:', JSON.stringify(buf.toString('utf-8')));
  }
  app.quit();
});
