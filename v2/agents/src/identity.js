const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function loadIdentity({ id, name = 'Agent', secret, dir } = {}) {
  const root =
    dir || process.env.PULSAR_HOME || path.join(os.homedir(), '.pulsar');
  const key = crypto
    .createHash('sha256')
    .update(id || name)
    .digest('hex')
    .slice(0, 24);
  const folder = path.join(root, 'identities');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${key}.json`);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT')
      throw new Error(
        `Cannot read identity file ${file}; restore it instead of creating a new identity.`,
      );
  }
  const identity = {
    agentId: id || saved?.agentId || `agent-${crypto.randomUUID()}`,
    secret:
      secret || saved?.secret || crypto.randomBytes(32).toString('base64url'),
  };
  if (!saved) {
    try {
      fs.writeFileSync(file, JSON.stringify(identity, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (e) {
      if (e.code === 'EEXIST') return loadIdentity({ id, name, secret, dir });
      throw e;
    }
  } else if (secret && secret !== saved.secret) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n', {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  }
  return { ...identity, memoryDir: path.join(root, 'memory'), file };
}
module.exports = { loadIdentity };
