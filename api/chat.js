export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, shopUrl, shopName, budget, tastes } = req.body;
  if (!messages) return res.status(400).json({ error: 'Missing messages' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const basePrompt = process.env.SYSTEM_PROMPT;
  if (!basePrompt) return res.status(500).json({ error: 'System prompt not configured' });

  const hasShop = shopUrl && shopUrl.length > 0;
  const hasTastes = tastes && tastes.length > 0;

  const userProfile = [
    '---',
    'USER PROFILE:',
    hasTastes ? 'Taste preferences: ' + tastes.join(', ') : null,
    budget ? 'Usual budget: up to $' + budget + ' per bottle. Do not recommend wines over this price unless asked.' : null,
    hasShop ? 'Preferred shop: ' + shopName + ' (' + shopUrl + '). Search for wines at this shop and include real product URLs.' : null,
    !hasShop ? 'No shop set — recommend from Australian retailers.' : null,
    '---',
    'CRITICAL: Your entire response must be a single valid JSON object. No other text before or after it. No narrative, no "let me search", no explanations outside the JSON.',
    'Format:',
    '{"text":"your intro in Winederella voice","wines":[{"name":"Wine Name","price":35,"priceRange":"$30-40","region":"Region","varietal":"Variety","description":"One sentence tasting note","why":"One sentence why it works for this request","url":"real product URL from web search or null","icon":"🍷","color":"#F5EAE8"}]}',
    'Colors: reds #F5EAE8, whites #EAF0F5, sparkling #F5F0EA, natural/orange #EDF5EA.',
    'If casual chat return wines:[].',
    'url must be a real URL found via web search — never invent one. Use null if not found.'
  ].filter(Boolean).join('\n');

  const fullSystem = basePrompt + '\n\n' + userProfile;

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
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: fullSystem,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });

    // Collect all text blocks
    const allText = data.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('') || '{}';

    // Extract just the JSON object — find the first { and last }
    const jsonStart = allText.indexOf('{');
    const jsonEnd = allText.lastIndexOf('}');
    const jsonText = jsonStart !== -1 && jsonEnd !== -1
      ? allText.slice(jsonStart, jsonEnd + 1)
      : '{"text":"Sorry, something went wrong. Please try again.","wines":[]}';

    return res.status(200).json({ content: [{ type: 'text', text: jsonText }] });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
