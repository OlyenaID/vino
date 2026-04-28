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

  // One system prompt, one API call, web search handles the rest
  const enrichedSystem = system + '\n\n' +
    (hasShop
      ? 'The user shops at ' + shopName + ' (' + shopUrl + '). ' +
        'When recommending wines, use your web_search tool to search for each wine at ' + shopName + '. ' +
        'For example search: "Penfolds Bin 28 Shiraz ' + shopName + '" to find the real product page URL. ' +
        'Only include a URL in your response if you actually found it via search — never guess URLs.'
      : 'No shop set — recommend wines from your knowledge without shop links.') +
    '\n\nRespond with raw JSON only (no markdown, no code fences):\n' +
    '{"text":"warm 1-2 sentence intro","wines":[' +
    '{"name":"Full wine name",' +
    '"varietal":"e.g. Shiraz",' +
    '"region":"e.g. Barossa Valley",' +
    '"style":"e.g. Full Bodied, Dry",' +
    '"price":28,' +
    '"priceRange":"$25-30",' +
    '"why":"2-3 sentences on why this wine works for this specific request — flavour profile, food match, occasion fit",' +
    '"url":"real product URL found via search, omit field if not found",' +
    '"icon":"🍷",' +
    '"color":"#F5EAE8"}]}\n' +
    'Colors: reds #F5EAE8, whites #EAF0F5, sparkling #F5F0EA, natural #EDF5EA.\n' +
    'Return 2-3 wines. Always include "why". If casual chat return wines:[].';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: enrichedSystem,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });

    // Extract the final text response from the content blocks
    const text = data.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || '{}';

    // Return in the same shape the frontend expects
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
