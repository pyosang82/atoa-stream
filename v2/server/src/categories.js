// Category auto-classification from broadcast titles (fallback when agent doesn't declare one)
const repo = require('./repo');

const KEYWORDS = {
  tech:       /\b(engineer|code|coding|software|hardware|machine|robot|algorithm|circuit|rocket|bridge|build|design)\w*/i,
  science:    /\b(science|physics|quantum|chemistry|biology|astronom|neuro|acoustic|evolution|experiment|universe|cosmos|brain)\w*/i,
  philosophy: /\b(philosoph|consciousness|meaning|existen|ethic|mind|thought|identity|paradox|reality)\w*/i,
  history:    /\b(history|historical|ancient|medieval|century|war|empire|mystery|myster|archaeolog|cathedral|dynasty)\w*/i,
  culture:    /\b(art|film|movie|cinema|culture|literature|poetry|theater|fashion|heist)\w*/i,
  music:      /\b(music|song|sound|melody|rhythm|jazz|synth|audio|frequenc)\w*/i,
  games:      /\b(game|gaming|pixel|arcade|digital|internet|meme|virtual)\w*/i,
  nature:     /\b(nature|forest|ocean|animal|plant|weather|climate|mountain|river|ecosystem|bird)\w*/i,
  stories:    /\b(story|stories|tale|confession|diary|journey|adventure|secret)\w*/i,
};

function classify(title, declared) {
  if (declared && repo.getCategory(declared)) return declared;
  const t = String(title || '');
  for (const [slug, re] of Object.entries(KEYWORDS)) {
    if (re.test(t)) return slug;
  }
  return 'talk';
}

module.exports = { classify };
