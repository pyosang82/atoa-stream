// Pure (DB-free) request classification used by analytics: bot UA detection, vulnerability-scanner
// path detection, UTM sanitising. Kept dependency-free so it is unit-testable without SQLite.

const BOT_PATTERNS = [
  ['claude-searchbot', /claude-searchbot/i], ['claudebot', /claudebot/i],
  ['oai-searchbot', /oai-searchbot/i], ['gptbot', /gptbot/i], ['chatgpt-user', /chatgpt-user/i],
  ['perplexitybot', /perplexitybot/i], ['googlebot', /googlebot|google-inspectiontool/i],
  ['bingbot', /bingbot/i], ['applebot', /applebot/i], ['amazonbot', /amazonbot/i],
  ['duckduckbot', /duckduckbot/i], ['yandex', /yandexbot/i], ['bytespider', /bytespider/i],
  ['ccbot', /ccbot/i], ['petalbot', /petalbot/i], ['facebook', /facebookexternalhit|meta-external/i],
  ['semrush', /semrushbot/i], ['ahrefs', /ahrefsbot/i], ['mj12', /mj12bot/i],
  ['headless', /headlesschrome|phantomjs|puppeteer|playwright/i],
  ['scanner', /virustotal|palo alto networks|xpanse|infrawatch|pixelgrab-radar/i],
  ['registry-crawler', /mcp.?registry|iconresolver|exorails-catalog|aegialabscensus|builtwith|BW\/1\./i],
  ['script', /^(curl|wget|python|go-http|node(?:\b|-fetch)|axios|libwww|okhttp|java|WordPress\/)/i],
  ['generic-bot', /bot\b|crawler|spider|scraper/i],
];
const AI_BOTS = new Set(['claude-searchbot', 'claudebot', 'oai-searchbot', 'gptbot', 'chatgpt-user', 'perplexitybot', 'bytespider', 'ccbot']);

function detectBot(ua) {
  if (!ua) return 'no-ua';
  for (const [name, re] of BOT_PATTERNS) if (re.test(ua)) return name;
  return null;
}

// Paths only vulnerability scanners request. A hit here is never a real visitor, whatever the UA.
const SCANNER_PATH = new RegExp([
  '(^|/)\\.(git|env|aws|ssh|svn|hg|DS_Store)(/|\\.|$)',
  '(^|/)(wp-(admin|login|content|includes|json)|xmlrpc\\.php|wp-config)',
  '(^|/)(phpmyadmin|pma|phpinfo|cgi-bin|vendor/phpunit|actuator|telescope|_ignition|owa|autodiscover|solr|jenkins|manager/html)(/|$)',
  '\\.(php|asp|aspx|jsp|cgi)(\\?|$)',
  '(^|/)(config|settings|secrets?|credentials|api_keys?|backup|dump|database)\\.(json|ya?ml|php|sql|env|bak|zip|tar|gz)$',
  '(^|/)server-status$',
  '(^|/)\\.well-known/(?!security\\.txt$)',
  '^https?://',            // absolute-URI requests = open-proxy probes
].join('|'), 'i');

const isScannerPath = (p) => SCANNER_PATH.test(String(p || ''));

// UTM values: keep only what a real campaign tag looks like; anything else (markup, junk) → null.
function sanitizeUtm(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 64);
  return /^[A-Za-z0-9_.\-]+$/.test(s) ? s : null;
}

module.exports = { BOT_PATTERNS, AI_BOTS, detectBot, isScannerPath, sanitizeUtm };
