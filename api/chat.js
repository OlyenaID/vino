export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, shopUrl, shopName, budget, tastes } = req.body;
  if (!messages) return res.status(400).json({ error: 'Missing messages' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

  const basePrompt = process.env.SYSTEM_PROMPT;
  if (!basePrompt) return res.status(500).json({ error: 'System prompt not configured' });

  const hasShop = shopUrl && shopUrl.length > 0;
  const hasTastes = tastes && tastes.length > 0;

  const userProfile = [
    '---',
    'USER PROFILE:',
    hasTastes ? 'Taste preferences: ' + tastes.join(', ') : null,
    budget ? 'Usual budget: up to $' + budget + ' per bottle. Only recommend wines at or under this price.' : null,
    hasShop
      ? 'Preferred shop: ' + shopName + ' (' + shopUrl + '). Browse this shop to find real wines with real current prices and direct product page URLs.'
      : 'No shop set — find wines from Australian retailers with real links.',
    '---',
    'CRITICAL: Respond with a single valid JSON object only. No text before or after it.',
    '{"text":"intro in Winederella voice","wines":[{"name":"Exact product name from the shop","price":35,"region":"Region","varietal":"Variety","description":"One sentence tasting note","why":"One sentence why it works for this request","url":"real product page URL you browsed","icon":"🍷","color":"#F5EAE8"}]}',
    'Colors: reds #F5EAE8, whites #EAF0F5, sparkling #F5F0EA, natural #EDF5EA.',
    'If casual chat return wines:[].',
    'price must be the real current price from the shop page — never guess.',
    'url must be the real product page URL you visited — never invent.'
  ].filter(Boolean).join('\n');

  const fullSystem = basePrompt + '\n\n' + userProfile;
  const recentMessages = messages.slice(-2);

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        instructions: fullSystem,
        input: recentMessages.map(m => ({
          role: m.role,
          content: m.content
        }))
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'OpenAI API error' });

    // Extract text from OpenAI responses format
    const text = data.output
      ?.filter(b => b.type === 'message')
      .flatMap(b => b.content)
      .filter(c => c.type === 'output_text')
      .map(c => c.text)
      .join('') || '{}';

    // Extract just the JSON object
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    const jsonText = jsonStart !== -1 && jsonEnd !== -1
      ? text.slice(jsonStart, jsonEnd + 1)
      : '{"text":"Sorry, something went wrong. Please try again.","wines":[]}';

    return res.status(200).json({ content: [{ type: 'text', text: jsonText }] });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
