export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system, shopUrl, shopName } = req.body;
  if (!messages || !system) return res.status(400).json({ error: 'Missing messages or system prompt' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });

  const hasShop = shopUrl && shopUrl.length > 0;

  try {
    // ── STEP 1: Get generic recommendations from Claude ──────────────────────
    // This always runs — gives us great recommendations based on Claude's wine knowledge.
    // For no-shop users this is the final answer.
    // For shop users this gives us precise wine names to search for.

    const genericSystem = system + '\n\n' +
      'Respond with raw JSON only (no markdown, no code fences):\n' +
      '{"text":"warm 1-2 sentence intro","wines":[' +
      '{"name":"Full producer and wine name","varietal":"e.g. Shiraz","region":"e.g. Barossa Valley",' +
      '"style":"e.g. Full Bodied, Dry","price":35,"priceRange":"$30-40",' +
      '"why":"2-3 sentences explaining exactly why this wine works for this specific request — mention flavour profile, food match logic, occasion fit, or how it matches the user taste profile",' +
      '"icon":"emoji","color":"#F5EAE8"}]}\n' +
      'Colors: reds #F5EAE8, whites #EAF0F5, sparkling #F5F0EA, natural #EDF5EA.\n' +
      'Return 2-3 wines. Always include "why" for every wine. If casual chat with no recommendation needed return wines:[].';

    const genericResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1200, system: genericSystem, messages })
    });

    const genericData = await genericResp.json();
    if (!genericResp.ok) return res.status(genericResp.status).json({ error: genericData.error?.message || 'Claude API error' });

    const rawGeneric = genericData.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '{}';

    let generic;
    try { generic = JSON.parse(rawGeneric.replace(/```json|```/g, '').trim()); }
    catch(e) { return res.status(200).json(genericData); }

    // ── No shop — return generic result directly ─────────────────────────────
    if (!hasShop || !generic.wines || generic.wines.length === 0) {
      return res.status(200).json(genericData);
    }

    // ── STEP 2: Search the shop for each recommended wine ────────────────────
    // Use Claude's web search tool to find each wine at the specific shop.
    // This gives us real prices and working product URLs.

    const winesWithLinks = await findWinesAtShop(generic.wines, shopUrl, shopName, apiKey);

    // ── STEP 3: Build final response merging recommendations + shop results ───
    const finalSystem = 'You are Vino, a warm wine concierge. ' +
      'You have generic wine recommendations AND real search results from ' + shopName + '. ' +
      'Match each generic recommendation to the best available product found at the shop. ' +
      'Keep the "why" justification from the generic recommendation but you may enhance it. ' +
      'Use the shop\'s exact product name, price and URL where found. ' +
      'Respond with raw JSON only (no markdown, no code fences):\n' +
      '{"text":"warm 1-2 sentence intro mentioning ' + shopName + '",' +
      '"wines":[{"name":"exact shop product name or generic name if not found",' +
      '"varietal":"...","region":"...","style":"...",' +
      '"price":35,"priceRange":"$30-40",' +
      '"why":"why this wine works for this request",' +
      '"url":"direct product URL from shop search or omit if not found",' +
      '"icon":"emoji","color":"#F5EAE8"}]}\n' +
      'If a wine was not found at the shop keep the generic recommendation without a URL. ' +
      'Always include "why" for every wine.';

    const finalMessages = [
      ...messages,
      { role: 'assistant', content: rawGeneric },
      {
        role: 'user',
        content: 'Here are the search results from ' + shopName + ' for each recommended wine:\n' +
          JSON.stringify(winesWithLinks, null, 2) + '\n\n' +
          'Now provide the final recommendation using real products from ' + shopName + ' where found. ' +
          'Preserve the "why" justification for each wine.'
      }
    ];

    const finalResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1500, system: finalSystem, messages: finalMessages })
    });

    const finalData = await finalResp.json();
    if (!finalResp.ok) return res.status(finalResp.status).json({ error: finalData.error?.message || 'Claude API error' });

    return res.status(200).json(finalData);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

// ── Find each wine at the shop using Claude web search ───────────────────────
async function findWinesAtShop(wines, shopUrl, shopName, apiKey) {
  const shopDomain = shopUrl.replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  const results = [];

  for (const wine of wines) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 400,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          system: 'Search for the wine "' + wine.name + '" at ' + shopName + ' (' + shopUrl + '). ' +
            'Find the exact product page. ' +
            'Respond with raw JSON only (no markdown):\n' +
            '{"found":true,"name":"exact product name","price":35,"url":"https://...direct product page url...","vintage":"2022"}\n' +
            'If not found respond with: {"found":false}',
          messages: [{ role: 'user', content: '"' + wine.name + '" site:' + shopDomain }]
        })
      });

      const data = await response.json();
      const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';

      let shopResult;
      try { shopResult = JSON.parse(text.replace(/```json|```/g, '').trim()); }
      catch(e) { shopResult = { found: false }; }

      results.push({ genericWine: wine, shopResult });

    } catch(err) {
      results.push({ genericWine: wine, shopResult: { found: false } });
    }
  }

  return results;
}
