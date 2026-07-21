const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('./uuid');
const { decryptAuthData: decryptTcAuthData, isTcEncrypted } = require('./trae-decrypt');

// Prefer APPDATA (may be redirected, e.g. D:\AppData\Roaming) over homedir\AppData\Roaming.
function getRoamingRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// Candidate product folders per edition. First existing storage.json wins for that edition.
const CN_PRODUCT_DIRS = ['TRAE SOLO CN', 'Trae CN', 'TRAE CN'];
const SG_PRODUCT_DIRS = ['TRAE SOLO', 'Trae', 'TRAE'];

function resolveProductDataDir(edition) {
  if (process.env.TRAE_DATA_DIR) return process.env.TRAE_DATA_DIR;
  const root = getRoamingRoot();
  const names = edition === 'cn' ? CN_PRODUCT_DIRS : SG_PRODUCT_DIRS;
  let best = null;
  let bestMtime = -1;
  for (const name of names) {
    const dir = path.join(root, name);
    const storagePath = path.join(dir, 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(storagePath)) continue;
    try {
      const mtime = fs.statSync(storagePath).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = dir;
      }
    } catch (e) {
      if (!best) best = dir;
    }
  }
  // Fallback to conventional Trae / Trae CN even if missing (error later).
  if (!best) {
    best = path.join(root, edition === 'cn' ? 'Trae CN' : 'Trae');
  }
  return best;
}

function getTraeDataDir() {
  const envDir = process.env.TRAE_DATA_DIR;
  if (envDir) return envDir;
  return resolveProductDataDir(detectEdition());
}

function detectEdition() {
  const envEdition = process.env.TRAE_EDITION;
  if (envEdition) {
    const e = envEdition.toLowerCase();
    // solo-cn / solo_cn treat as cn crypto + CN API hosts
    if (e === 'solo' || e === 'solo-cn' || e === 'solo_cn' || e === 'cn') return 'cn';
    return e;
  }

  const cnDir = resolveProductDataDir('cn');
  const sgDir = resolveProductDataDir('sg');
  const cnPath = path.join(cnDir, 'User', 'globalStorage', 'storage.json');
  const sgPath = path.join(sgDir, 'User', 'globalStorage', 'storage.json');

  const cnExists = fs.existsSync(cnPath);
  const sgExists = fs.existsSync(sgPath);

  if (cnExists && !sgExists) return 'cn';
  if (!cnExists && sgExists) return 'sg';
  if (cnExists && sgExists) {
    try {
      const cnStat = fs.statSync(cnPath);
      const sgStat = fs.statSync(sgPath);
      return cnStat.mtime > sgStat.mtime ? 'cn' : 'sg';
    } catch (e) {
      return 'sg';
    }
  }
  return 'sg';
}

function getStorageJsonPath(edition) {
  const ed = edition || detectEdition();
  const dataDir = resolveProductDataDir(ed);
  return path.join(dataDir, 'User', 'globalStorage', 'storage.json');
}

function readStorageJson() {
  const storagePath = getStorageJsonPath();
  if (!fs.existsSync(storagePath)) {
    throw new Error(`storage.json not found at: ${storagePath}`);
  }
  const raw = fs.readFileSync(storagePath, 'utf-8');
  return JSON.parse(raw);
}

function isEncryptedAuthData(raw) {
  if (!raw || typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) return false;
  return true;
}

function readStorageJsonByEdition(edition) {
  const dataDir = resolveProductDataDir(edition);
  const storagePath = path.join(dataDir, 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storagePath)) return null;
  const raw = fs.readFileSync(storagePath, 'utf-8');
  return JSON.parse(raw);
}

let _cachedAuthInfo = null;

function getAuthInfo() {
  if (_cachedAuthInfo && !isTokenExpired(_cachedAuthInfo)) {
    return _cachedAuthInfo;
  }

  const edition = detectEdition();
  const editions = [edition, edition === 'cn' ? 'sg' : 'cn'];

  for (const ed of editions) {
    try {
      const dataDir = resolveProductDataDir(ed);

      try {
        const auth = decryptTcAuthData(dataDir);
        console.log(`[auth] Using ${ed.toUpperCase()} edition auth data from ${dataDir} (decrypted)`);
        _cachedAuthInfo = {
          token: auth.token,
          refreshToken: auth.refreshToken,
          expiredAt: auth.expiredAt,
          refreshExpiredAt: auth.refreshExpiredAt,
          tokenReleaseAt: auth.tokenReleaseAt,
          userId: auth.userId,
          host: auth.host,
          userRegion: auth.userRegion,
          account: auth.account,
          _edition: ed,
          _wasEncrypted: true
        };
        return _cachedAuthInfo;
      } catch (decryptErr) {
        console.log(`[auth] ${ed.toUpperCase()} decryption failed: ${decryptErr.message}, trying plaintext`);
      }

      const storage = readStorageJsonByEdition(ed);
      if (!storage) continue;

      const authKey = 'iCubeAuthInfo://icube.cloudide';
      const authRaw = storage[authKey];
      if (!authRaw) continue;

      if (isEncryptedAuthData(authRaw)) {
        console.log(`[auth] ${ed.toUpperCase()} edition auth data is encrypted and decryption failed, skipping`);
        continue;
      }

      const auth = JSON.parse(authRaw);
      console.log(`[auth] Using ${ed.toUpperCase()} edition auth data (plaintext)`);
      _cachedAuthInfo = {
        token: auth.token,
        refreshToken: auth.refreshToken,
        expiredAt: auth.expiredAt,
        refreshExpiredAt: auth.refreshExpiredAt,
        tokenReleaseAt: auth.tokenReleaseAt,
        userId: auth.userId,
        host: auth.host,
        userRegion: auth.userRegion,
        account: auth.account,
        _edition: ed,
        _wasEncrypted: false
      };
      return _cachedAuthInfo;
    } catch (e) {
      console.log(`[auth] Failed to read ${ed.toUpperCase()} edition: ${e.message}`);
      continue;
    }
  }

  const manualToken = process.env.TRAE_MANUAL_TOKEN;
  if (manualToken && manualToken.startsWith('eyJ')) {
    console.log('[auth] Using manual token from TRAE_MANUAL_TOKEN env');
    const apiHost = process.env.TRAE_API_HOST || 'https://trae-api-cn.mchost.guru';
    try {
      const parts = manualToken.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const expMs = payload.exp * 1000;
      const isExpired = Date.now() > expMs;
      if (isExpired) {
        console.log('[auth] Manual token is expired, exp:', new Date(expMs).toISOString());
      }
      return {
        token: manualToken,
        refreshToken: null,
        expiredAt: new Date(expMs).toISOString(),
        refreshExpiredAt: null,
        tokenReleaseAt: null,
        userId: payload.data?.id || null,
        host: apiHost,
        userRegion: null,
        account: null,
        _edition: 'manual'
      };
    } catch (e) {
      return {
        token: manualToken,
        refreshToken: null,
        expiredAt: null,
        refreshExpiredAt: null,
        tokenReleaseAt: null,
        userId: null,
        host: apiHost,
        userRegion: null,
        account: null,
        _edition: 'manual'
      };
    }
  }

  throw new Error('No readable auth info found in any edition. CN edition data is encrypted and SG edition data is not available.');
}

function getDeviceIds() {
  const edition = detectEdition();
  const editions = [edition, edition === 'cn' ? 'sg' : 'cn'];
  for (const ed of editions) {
    const storage = readStorageJsonByEdition(ed);
    if (storage && storage['telemetry.machineId']) {
      return {
        machineId: storage['telemetry.machineId'] || '',
        sqmId: storage['telemetry.sqmId'] || '',
        devDeviceId: storage['telemetry.devDeviceId'] || ''
      };
    }
  }
  return { machineId: '', sqmId: '', devDeviceId: '' };
}

function isTokenExpired(authInfo) {
  if (!authInfo || !authInfo.expiredAt) return true;
  const expiry = new Date(authInfo.expiredAt);
  if (isNaN(expiry.getTime())) return true; // Invalid date = treat as expired
  return expiry < new Date();
}

function isTokenExpiringSoon(authInfo, minutesThreshold) {
  if (!authInfo || !authInfo.expiredAt) return true;
  const expiresAt = new Date(authInfo.expiredAt);
  if (isNaN(expiresAt.getTime())) return true; // Invalid date = treat as expiring
  const threshold = minutesThreshold || 30;
  const warningTime = new Date(Date.now() + threshold * 60 * 1000);
  return expiresAt < warningTime;
}

// Default Trae API hosts (overridable via env). These are shared Trae-client
// endpoints (not per-user secrets); defaults are required for the wrapper to work.
const DEFAULT_HOST_CN = process.env.TRAE_HOST_CN || 'https://trae-api-cn.mchost.guru';
const DEFAULT_HOST_SG = process.env.TRAE_HOST_SG || 'https://coresg-normal.trae.ai';
const DEFAULT_HOST_US = process.env.TRAE_HOST_US || 'https://coreva-normal.trae.ai';

// Default IDE version/device info (overridable via env). Used as fallback when
// Trae's manifest.json cannot be read. Update when Trae CN/SG releases new builds.
const DEFAULT_IDE_VERSION_CN = '3.3.67';
const DEFAULT_IDE_VERSION_SG = '3.5.51';
const DEFAULT_IDE_VERSION_CODE = '20260401';

function getApiHost() {
  const envHost = process.env.TRAE_API_HOST;
  if (envHost) return envHost;

  try {
    const authInfo = getAuthInfo();
    const authEdition = authInfo._edition;
    if (authEdition === 'cn') {
      return DEFAULT_HOST_CN;
    }
    const region = (authInfo.userRegion?.region || authInfo.userRegion || '').toString().toUpperCase();
    if (region === 'US') return DEFAULT_HOST_US;
    return DEFAULT_HOST_SG;
  } catch (e) {
    return DEFAULT_HOST_SG;
  }
}

function getAuthHost() {
  const envHost = process.env.TRAE_AUTH_HOST;
  if (envHost) return envHost;

  try {
    const authInfo = getAuthInfo();
    if (authInfo._edition === 'cn') {
      return DEFAULT_HOST_CN;
    }
    return DEFAULT_HOST_SG;
  } catch (e) {
    return DEFAULT_HOST_SG;
  }
}

async function exchangeToken(refreshToken) {
  const authInfo = getAuthInfo();
  const authHost = getAuthHost();
  const url = `${authHost}/cloudide/api/v3/trae/oauth/ExchangeToken`;

  const body = {
    ClientID: process.env.TRAE_OAUTH_CLIENT_ID || 'ono9krqynydwx5',
    RefreshToken: refreshToken,
    ClientSecret: process.env.TRAE_OAUTH_CLIENT_SECRET || '-',
    UserID: ''
  };

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
  if (proxyUrl) {
    try {
      if (proxyUrl.startsWith('socks')) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        fetchOptions.agent = new SocksProxyAgent(proxyUrl);
      } else {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
      }
    } catch (e) {
      console.error(`[auth] proxy setup failed: ${e.message}`);
    }
  }

  const resp = await fetch(url, fetchOptions);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ExchangeToken failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return data;
}

let _refreshPromise = null; // Mutex for token refresh

async function refreshTokenIfNeeded() {
  const authInfo = getAuthInfo();

  if (authInfo._edition === 'manual') {
    if (!isTokenExpired(authInfo)) {
      return authInfo;
    }
    throw new Error('Manual token expired. Please update TRAE_MANUAL_TOKEN in .env file.');
  }

  if (!isTokenExpiringSoon(authInfo, 30)) {
    return authInfo;
  }

  // Mutex: if a refresh is already in progress, wait for it
  if (_refreshPromise) {
    return _refreshPromise;
  }

  _refreshPromise = (async () => {
    console.log(`Token expiring soon or expired (at ${authInfo.expiredAt}), attempting refresh...`);

    try {
      const result = await exchangeToken(authInfo.refreshToken);
      if (result && result.token) {
        const newAuth = {
          ...authInfo,
          token: result.token,
          refreshToken: result.refreshToken || authInfo.refreshToken,
          expiredAt: result.expiredAt,
          refreshExpiredAt: result.refreshExpiredAt || authInfo.refreshExpiredAt,
          tokenReleaseAt: result.tokenReleaseAt || authInfo.tokenReleaseAt
        };

        if (authInfo._wasEncrypted) {
          console.log(`Token refreshed successfully (in-memory only, original data was encrypted), new expiry: ${newAuth.expiredAt}`);
          _cachedAuthInfo = newAuth;
          return newAuth;
        }

        const storage = readStorageJsonByEdition(authInfo._edition || detectEdition());
        const authKey = 'iCubeAuthInfo://icube.cloudide';
        storage[authKey] = JSON.stringify({
          token: newAuth.token,
          refreshToken: newAuth.refreshToken,
          expiredAt: newAuth.expiredAt,
          refreshExpiredAt: newAuth.refreshExpiredAt,
          tokenReleaseAt: newAuth.tokenReleaseAt,
          userId: newAuth.userId,
          host: newAuth.host,
          userRegion: newAuth.userRegion,
          account: newAuth.account
        });

        const storagePath = getStorageJsonPath(authInfo._edition);
        fs.writeFileSync(storagePath, JSON.stringify(storage, null, '\t'), 'utf-8');
        console.log(`Token refreshed successfully, new expiry: ${newAuth.expiredAt}`);
        _cachedAuthInfo = newAuth;
        return newAuth;
      } else {
        console.error('Token refresh returned no token');
        if (isTokenExpired(authInfo)) {
          throw new Error('Token expired and refresh returned no token. Please restart Trae IDE to re-authenticate.');
        }
        return authInfo;
      }
    } catch (err) {
      console.error(`Token refresh failed: ${err.message}`);
      if (isTokenExpired(authInfo)) {
        throw new Error('Token expired and refresh failed. Please restart Trae IDE to re-authenticate.');
      }
    } finally {
      _refreshPromise = null; // Clear mutex
    }

    return authInfo;
  })();

  return _refreshPromise;
}

function findManifestPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    process.env.TRAE_INSTALL_DIR,
    path.join('D:', 'software', 'TRAE SOLO CN'),
    path.join('E:', 'software', 'Trae CN'),
    path.join(localAppData, 'Programs', 'TRAE SOLO CN'),
    path.join(localAppData, 'Programs', 'Trae CN'),
    path.join(localAppData, 'Programs', 'Trae-CN'),
    path.join(localAppData, 'Programs', 'TRAE SOLO'),
    path.join(localAppData, 'Programs', 'Trae'),
  ].filter(Boolean);
  return candidates.map((dir) => path.join(dir, 'manifest.json'));
}

function readManifest() {
  for (const manifestPath of findManifestPaths()) {
    try {
      if (!fs.existsSync(manifestPath)) continue;
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {}
  }
  return null;
}

function getIdeVersion() {
  // Explicit env override takes highest priority
  if (process.env.TRAE_IDE_VERSION) return process.env.TRAE_IDE_VERSION;

  // SOLO real traffic uses appVersion (e.g. 0.1.38), NOT tron buildVersion.
  try {
    const manifest = readManifest();
    if (manifest) {
      if (isSoloProduct() && manifest.appVersion) return String(manifest.appVersion);
      // Classic Trae CN often uses appVersion too in headers; prefer appVersion then buildVersion
      if (manifest.appVersion) return String(manifest.appVersion);
      if (manifest.buildVersion) return String(manifest.buildVersion);
    }
  } catch (e) {
    // Fall through to defaults
  }

  try {
    const authInfo = getAuthInfo();
    if (authInfo._edition === 'cn') return isSoloProduct() ? '0.1.38' : DEFAULT_IDE_VERSION_CN;
    return DEFAULT_IDE_VERSION_SG;
  } catch (e) {
    return isSoloProduct() ? '0.1.38' : DEFAULT_IDE_VERSION_CN;
  }
}

function getIdeVersionCode() {
  if (process.env.TRAE_IDE_VERSION_CODE) return process.env.TRAE_IDE_VERSION_CODE;
  // SOLO observed code like 20260716 (date-based). Prefer env; else derive from today for solo.
  if (isSoloProduct()) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }
  return DEFAULT_IDE_VERSION_CODE;
}

// SOLO stores real aha device id in storage key: iCubeAuthInfo://icube-dc:<deviceId>
function extractSoloDeviceId(storage) {
  if (!storage || typeof storage !== 'object') return '';
  for (const key of Object.keys(storage)) {
    const m = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/.exec(key);
    if (m) return m[1];
  }
  return '';
}

function isSoloProduct() {
  if (process.env.TRAE_PRODUCT) {
    return String(process.env.TRAE_PRODUCT).toLowerCase().includes('solo');
  }
  try {
    const dataDir = getTraeDataDir();
    return /solo/i.test(dataDir || '');
  } catch (e) {
    return false;
  }
}

function getDeviceInfo() {
  const authInfo = getAuthInfo();
  const storage = readStorageJsonByEdition(authInfo._edition || detectEdition()) || {};
  const machineId = storage['telemetry.machineId'] || '';
  const sqmId = storage['telemetry.sqmId'] || '';
  const devDeviceId = storage['telemetry.devDeviceId'] || '';
  const soloDeviceId = extractSoloDeviceId(storage);
  // SOLO real traffic uses aha device id (digits), not hash(machineId).
  const deviceId = process.env.TRAE_DEVICE_ID
    || soloDeviceId
    || hashDeviceId(machineId)
    || '';
  return {
    cpu: process.env.TRAE_CPU || 'Intel',
    device_id: deviceId,
    machine_id: machineId || process.env.TRAE_MACHINE_ID || '',
    device_model: process.env.TRAE_DEVICE_MODEL || (isSoloProduct() ? '83DG' : '82RF'),
    os_name: process.env.TRAE_OS_NAME || 'windows',
    os_version: process.env.TRAE_OS_VERSION || (isSoloProduct() ? 'Windows 11 Pro' : 'Windows 10'),
    sqm_id: sqmId,
    dev_device_id: devDeviceId,
    is_solo: isSoloProduct()
  };
}

function buildCommonHeaders(authInfo, deviceIds) {
  const deviceInfo = getDeviceInfo();
  const traceId = uuidv4().replace(/-/g, '');
  const spanId = uuidv4().replace(/-/g, '').slice(0, 16);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${authInfo.token}`,
    'X-Cloudide-Token': authInfo.token,
    'x-app-id': process.env.TRAE_APP_ID || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': 'default',
    'x-ide-version-code': getIdeVersionCode(),
    'x-app-version-code': getIdeVersionCode(),
    'x-custom-trace-id': traceId,
    // SOLO also sends W3C traceparent-like header
    'x-flow-traceparent': `04-${traceId}-${spanId}-01`,
    'x-device-brand': deviceInfo.device_model,
    'x-device-cpu': deviceInfo.cpu,
    'x-device-id': deviceInfo.device_id,
    'x-machine-id': deviceInfo.machine_id,
    'x-os-version': deviceInfo.os_version,
    'x-device-type': deviceInfo.os_name,
    'x-ide-version': getIdeVersion(),
    'x-ide-version-type': 'stable',
    'request-traffic-type': 'prod',
    'x-uid': authInfo.userId || ''
  };
  return headers;
}

function buildStreamHeaders(authInfo, deviceIds, requestId, lastEventId) {
  const headers = buildCommonHeaders(authInfo, deviceIds);
  headers['Accept'] = 'text/event-stream';
  headers['X-Request-ID'] = requestId || uuidv4();
  headers['X-Trae-Request-ID'] = headers['X-Request-ID'];
  if (lastEventId) {
    headers['Last-Event-ID'] = lastEventId;
  }
  return headers;
}

function hashDeviceId(machineId) {
  if (!machineId) return '';
  let hash = 0;
  for (let i = 0; i < machineId.length; i++) {
    const char = machineId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString().padStart(19, '0');
}

module.exports = {
  getTraeDataDir,
  getStorageJsonPath,
  readStorageJson,
  getAuthInfo,
  getDeviceIds,
  getDeviceInfo,
  isTokenExpired,
  isTokenExpiringSoon,
  getApiHost,
  getAuthHost,
  getIdeVersion,
  getIdeVersionCode,
  exchangeToken,
  refreshTokenIfNeeded,
  buildCommonHeaders,
  buildStreamHeaders,
  hashDeviceId,
  detectEdition,
  isSoloProduct,
  extractSoloDeviceId
};
